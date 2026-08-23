"use client";

/**
 * 홈의 카드 만들기 영역 (SPEC §4-1, M2) — 클라이언트 컴포넌트.
 *
 * 세 가지 입력 흐름 — 진행 UI가 실제 호출 단계와 1:1로 일치한다 (SPEC §3):
 *
 * - **사진(통합 경로)**: 판독(/api/extract) → 식별(/api/identify) →
 *   [본문 판독(/api/pages)] → 생성(/api/card)
 *   = "표지 읽는 중 → 책 확인 중 → [본문 읽는 중] → 카드 만드는 중".
 *   표지는 필수, 본문·목차는 **선택**이다. 본문 사진을 고르지 않으면 대괄호 단계가
 *   통째로 빠져 AI 호출 수·프롬프트 내용이 표지만 쓰던 예전 흐름과 완전히 같다.
 *   한때 "표지만"과 "표지+본문"을 별도 진입점으로 나눴는데, 겹치는 사진 흐름이 둘이라
 *   혼란스럽다는 사용자 피드백으로 `runRichFlow` 하나로 합쳤다(story-3).
 *   판독 실패(retake)는 §9 폴백: 안내 + 수동 폼(판독된 값이 있으면 프리필).
 * - 책 이름: 제목(+저자 선택)만으로 시작 — 판독 생략, 식별 → 생성.
 *   AR 미확보이므로 levelEstimated=true (카드에 "레벨 추정" 배지, HARNESS §3-2).
 * - 직접 입력(고급·§9 폴백): M1의 전체 메타데이터 폼 유지. 제출 시에도 식별을
 *   거쳐 썸네일·소개글을 보강한다(사용자가 쓴 소개글이 우선).
 *
 * 사진은 클라이언트에서 canvas로 긴 변 ~1500px JPEG로 리사이즈해 보낸다
 * (토큰 절약 — ai-harness-impl 스킬 권장). 서버는 판독 후 사진을 저장하지 않는다(SPEC §1·§5).
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BookExtraction, SceneDigestItem, SceneSourceKind } from "@/lib/ai/english/schemas";
import type { IdentifyResult } from "@/lib/identify";
import { resizeToJpegDataUrl } from "@/lib/image-resize";
import ImageCropper from "@/components/image-cropper";
import { COVER_MAX_IMAGES } from "@/lib/upload-limits";

// ---------------------------------------------------------------------------
// 타입·상수
// ---------------------------------------------------------------------------

type StepId = "extract" | "identify" | "pages" | "card";

/** 진행 UI 문구 (SPEC §3) — 단계 id가 곧 실제 API 호출이다 */
const STEP_LABEL: Record<StepId, string> = {
  extract: "표지 읽는 중",
  identify: "책 확인 중",
  pages: "본문 읽는 중",
  card: "카드 만드는 중",
};

interface DuplicateInfo {
  bookId: string;
  cardId: string | null;
}

/** `/api/pages` 응답 중 UI가 쓰는 부분 (라우트 응답 shape과 1:1) */
interface PagesBatchOutcome {
  batchIndex: number;
  imageCount: number;
  fromImageIndex: number;
  toImageIndex: number;
  ok: boolean;
  errorMessage: string | null;
}

interface PagesReview {
  sourceKind: SceneSourceKind;
  scenes: SceneDigestItem[];
  batches: PagesBatchOutcome[];
  failedBatchCount: number;
  messageKo: string | null;
}

/** 판독 실패(retake) 시 수동 폼에 미리 채울 값 */
interface ManualPrefill {
  title: string;
  author: string;
  series: string;
  isFiction: boolean | null;
  arLevel: number | null;
  lexile: number | null;
  wordCount: number | null;
  arQuizNo: string;
  topic: string;
  coverEmoji: string;
}

/* 색·크기는 app/globals.css의 토큰 클래스만 쓴다 (docs/DESIGN.md §7) */
const inputCls = "u-input";
const labelCls = "u-label";
/** 입력 패널 상자 — 흰 배경 + line 경계 + 카드 모서리 (DESIGN §5) */
const panelCls =
  "mt-6 rounded-[var(--radius-card)] border border-line bg-bg p-5 sm:p-6";

// ---------------------------------------------------------------------------
// 식별 결과 → 카드 입력 보조
// ---------------------------------------------------------------------------

/** 카테고리 문자열로 픽션/논픽션 추정 (예: "Juvenile Fiction" / "Juvenile Nonfiction") */
function guessFictionFromCategories(categories?: string[] | null): boolean | null {
  if (!categories?.length) return null;
  const joined = categories.join(" ").toLowerCase();
  if (joined.includes("nonfiction") || joined.includes("non-fiction")) return false;
  if (joined.includes("fiction")) return true;
  return null;
}

function joinedCategories(found: IdentifyResult | null): string {
  return found?.categories?.length ? found.categories.slice(0, 3).join(", ") : "";
}

/**
 * 판독 수치 정리 (QA m2-1 F1) — /api/card의 zod 경계(app/api/card/route.ts:
 * arLevel 0~13 / lexile 0~2000 / wordCount 1~1,000,000) 밖 값은 오독일 가능성이
 * 높다(예: Lexile 스티커 "BR40L" → -40). 범위 밖이면 null("미상")로 강등해
 * 기존 레벨 추정 경로가 받아주게 한다 — 서버 스키마는 그대로 두고,
 * 사진 흐름이 결정론적 400 재시도 루프에 빠지지 않게 하는 클라이언트측 정리다.
 */
function inRangeOrNull(v: number | null, min: number, max: number): number | null {
  return v != null && v >= min && v <= max ? v : null;
}

// ---------------------------------------------------------------------------
// 컴포넌트
// ---------------------------------------------------------------------------

export default function HomeCreate({
  /**
   * 본문 사진 상한·배치 크기는 `lib/ai/client.ts`가 단일 정의처다(PAGES_MAX_IMAGES /
   * PAGES_BATCH_SIZE). 그 모듈은 `openai`와 API 키를 건드리므로 클라이언트에서
   * import할 수 없어, 서버 컴포넌트(app/page.tsx)가 읽어 props로 내려준다.
   * 숫자를 여기 다시 적지 않기 위한 우회로다.
   */
  pagesMaxImages,
  pagesBatchSize,
}: {
  pagesMaxImages: number;
  pagesBatchSize: number;
}) {
  const router = useRouter();

  /** 열려 있는 입력 패널 — title(제목만) / manual(전체 폼, 고급·폴백) / pages(본문 촬영) */
  const [panel, setPanel] = useState<"none" | "title" | "manual" | "photo">("none");
  /** 현재 흐름의 단계 목록(진행 UI에 그대로 표시)과 진행 중 단계 */
  const [steps, setSteps] = useState<StepId[]>([]);
  const [phase, setPhase] = useState<StepId | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  /** 판독 실패 안내 ("다시 찍어주세요" — 수동 폼 위에 표시, SPEC §9) */
  const [retakeKo, setRetakeKo] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);
  /** 수동 폼 프리필 값 — prefillKey로 폼을 리마운트해 defaultValue를 적용한다 */
  const [prefill, setPrefill] = useState<ManualPrefill | null>(null);
  const [prefillKey, setPrefillKey] = useState(0);

  /** --- 본문·목차 촬영 (선택 경로) --- */
  const [coverFiles, setCoverFiles] = useState<File[]>([]);
  const [pageFiles, setPageFiles] = useState<File[]>([]);
  /** 표지 미리보기 URL — coverFiles와 짝을 맞춰 유지한다(아래 useEffect가 관리) */
  const [coverPreviews, setCoverPreviews] = useState<string[]>([]);
  /** 자르기 모달에 올릴 표지의 인덱스. null이면 모달을 닫는다. (담긴 뒤 "다시 자르기") */
  const [coverCropIndex, setCoverCropIndex] = useState<number | null>(null);
  /**
   * 자르기 대기 큐 — 새로 고른 표지들은 목록에 넣기 전에 여기 쌓여, 맨 앞부터 한 장씩
   * 자동으로 자르기 모달이 열린다. onDone이면 결과를 목록에 넣고, 취소면 그 장만 버린 뒤
   * 둘 다 큐를 한 칸 당긴다(다음 장 자동 오픈). 여러 장을 한 번에 골라도 순차로 자른다.
   */
  const [coverQueue, setCoverQueue] = useState<File[]>([]);
  /** 본문 전체 촬영인지, 챕터북 목차 1~2장인지 (배지·프롬프트가 갈린다) */
  const [sceneKind, setSceneKind] = useState<SceneSourceKind>("pages");
  /** 본문 판독 결과 확인 단계 — 이 값이 있으면 카드 생성 전에 검토 패널을 띄운다 */
  const [review, setReview] = useState<PagesReview | null>(null);
  /** "본문 읽는 중" 진행 표시용 — 사진이 많으면 오래 걸려 멈춘 줄 알기 쉽다 */
  const [pagesProgress, setPagesProgress] = useState<{ images: number; batches: number } | null>(
    null,
  );
  const [elapsedSec, setElapsedSec] = useState(0);

  const lastCardPayload = useRef<Record<string, unknown> | null>(null);
  /** 오류 패널의 "재시도"가 다시 실행할 동작 (실패한 단계부터) */
  const retryAction = useRef<(() => void) | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  /**
   * 표지 파일 → 미리보기 object URL 캐시. File 객체는 담을 때(덧붙이기)·자를 때(교체)
   * 참조가 유지되므로, File 기준으로 URL을 재사용하면 매 렌더마다 URL을 새로 만들지 않는다.
   */
  const coverUrlCacheRef = useRef<Map<File, string>>(new Map());
  const panelRef = useRef<HTMLDivElement>(null);
  // 검토 패널은 본문 촬영 패널과 동시에 마운트된다(촬영 패널은 hidden). 같은 ref를
  // 나눠 쓰면 스크롤이 숨겨진 쪽으로 가므로 각자 ref를 쓴다.
  const reviewRef = useRef<HTMLDivElement>(null);
  /** 검토 패널에서 "이대로 만들기"를 누를 때 쓸, 근거를 뺀 카드 페이로드 */
  const pendingCardPayload = useRef<Record<string, unknown> | null>(null);
  /** "본문 다시 찍기"가 판독·식별을 다시 하지 않도록 캐시해 둔다 */
  const richContext = useRef<{ title: string; author: string | null; isFiction: boolean; topic: string } | null>(
    null,
  );
  /** 본문 흐름의 판독 결과 — 400 폴백에서 수동 폼을 프리필하는 데 쓴다 (§9) */
  const richExtraction = useRef<BookExtraction | null>(null);
  /**
   * 지금 고른 표지에 대한 판독·식별이 끝났는가.
   * true면 본문 사진만 다시 골라도 표지 판독(vision 호출)을 다시 하지 않는다.
   * 표지를 다시 고르면 false로 되돌려 전체 흐름을 다시 태운다.
   */
  const pagesFlowReady = useRef(false);

  const busy = phase !== null;

  // 경과 시간 — 본문 판독 중에만 센다. 40장이면 배치 7개라 1분을 넘길 수 있어,
  // 아무 변화가 없으면 사용자가 멈춘 줄 알고 새로고침한다(그러면 비용만 날아간다).
  useEffect(() => {
    if (phase !== "pages") {
      setElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // 표지 미리보기 URL을 coverFiles와 동기화 — 새 파일엔 URL을 만들고, 빠진 파일 URL은 해제한다.
  useEffect(() => {
    const cache = coverUrlCacheRef.current;
    const urls = coverFiles.map((f) => {
      let url = cache.get(f);
      if (!url) {
        url = URL.createObjectURL(f);
        cache.set(f, url);
      }
      return url;
    });
    // 더 이상 목록에 없는 파일의 URL은 해제(자르기 교체·전체 지우기·언마운트 정리)
    for (const [f, url] of cache) {
      if (!coverFiles.includes(f)) {
        URL.revokeObjectURL(url);
        cache.delete(f);
      }
    }
    setCoverPreviews(urls);
  }, [coverFiles]);

  // 언마운트 시 남은 표지 미리보기 URL 정리
  useEffect(() => {
    const cache = coverUrlCacheRef.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  function clearStatus() {
    setErrorKo(null);
    setCanRetry(false);
    setDuplicate(null);
    setRetakeKo(null);
  }

  /** 실패 공통 처리 — 진행 표시를 끄고 오류 패널을 띄운다 */
  function fail(messageKo: string, retriable: boolean) {
    setPhase(null);
    setErrorKo(messageKo);
    setCanRetry(retriable);
  }

  /**
   * 표지 한 장을 자른 결과로 교체 — 미리보기 URL은 위 useEffect가 알아서 맞춘다.
   * 표지가 바뀌면 판독 결과가 무효이므로(원래 "표지 사진 담기" onChange와 같은 처리),
   * 다음 실행이 처음부터 다시 타게 한다.
   */
  function replaceCover(index: number, next: File) {
    setCoverFiles((prev) => prev.map((f, i) => (i === index ? next : f)));
    clearStatus();
    pagesFlowReady.current = false;
    setReview(null);
  }

  function scrollToPanel() {
    setTimeout(
      () =>
        (reviewRef.current ?? panelRef.current)?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        }),
      30,
    );
  }

  // -------------------------------------------------------------------------
  // (3) 생성 — /api/card (모든 흐름의 마지막 단계)
  // -------------------------------------------------------------------------

  async function runCard(
    payload: Record<string, unknown>,
    opts?: {
      /**
       * 400 invalid_input 수신 시 대체 처리 (QA m2-1 F1 보조안).
       * 400은 같은 페이로드를 다시 보내도 결과가 같아 "재시도"가 무익하다 —
       * 사진 흐름처럼 열린 폼이 없는 호출측은 이 훅으로 §9 수동 폼 폴백에 연결한다.
       * 미지정 시 기존 동작(오류 패널 + 재시도 버튼) 유지.
       */
      onInvalidInput?: (messageKo?: string) => void;
    },
  ) {
    lastCardPayload.current = payload;
    // 카드 단계 실패의 재시도는 카드 호출만 다시 한다 (판독·식별 결과 재사용)
    retryAction.current = () => {
      setSteps(["card"]);
      void runCard(payload, opts);
    };
    setPhase("card");
    setErrorKo(null);
    setCanRetry(false);
    setDuplicate(null);
    let navigating = false;
    try {
      const res = await fetch("/api/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            cardId?: string | null;
            bookId?: string;
            reason?: string;
            error?: string;
            messageKo?: string;
          }
        | null;

      if (res.ok && data?.ok && data.cardId) {
        navigating = true;
        router.push(`/card/${data.cardId}`);
        return;
      }
      if (data?.reason === "duplicate" && data.bookId) {
        // 동일 책 재등록 (SPEC §9) — 기존 카드로 이동 + "그래도 새로 만들기"
        setDuplicate({ bookId: data.bookId, cardId: data.cardId ?? null });
        return;
      }
      if (res.status === 400 && opts?.onInvalidInput) {
        // 입력 거절(400)은 재전송으로 해결되지 않는다 — 호출측 폴백으로 위임 (QA F1)
        opts.onInvalidInput(data?.messageKo);
        return;
      }
      setErrorKo(data?.messageKo ?? "알 수 없는 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
      setCanRetry(true);
    } catch {
      setErrorKo("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
      setCanRetry(true);
    } finally {
      if (!navigating) setPhase(null);
    }
  }

  // -------------------------------------------------------------------------
  // (2) 식별 — /api/identify (실패해도 카드 생성을 막지 않는다, SPEC §9)
  // -------------------------------------------------------------------------

  async function identifyClient(
    title: string,
    author?: string | null,
  ): Promise<IdentifyResult | null> {
    try {
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, author: author || undefined }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; result?: IdentifyResult }
        | null;
      if (res.ok && data?.ok && data.result) return data.result;
    } catch {
      // 무시 — 식별 실패 시 커버는 이모지, 소개글은 "없음"으로 진행
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 흐름 1 — 사진: 판독 → 식별 → [본문 판독] → 생성
  //
  // 사진 경로는 **하나뿐이다**. 표지만 쓰는 사람과 본문까지 찍는 사람이 같은 패널에서
  // 시작하고, 본문 사진을 고르지 않으면 pages 단계가 통째로 빠져 예전 표지 흐름과
  // 완전히 같아진다(호출 수·프롬프트 내용까지 동일 — 리포트 §5 실측).
  // -------------------------------------------------------------------------

  /**
   * 사진 경로의 유일한 진입점 — 패널을 열면서 **곧바로 표지 선택창을 띄운다.**
   *
   * 패널을 먼저 보여주고 그 안의 버튼을 누르게 하면 표지만 찍는 사람의 탭이 한 번 더
   * 는다. 파일 입력을 항상 마운트해 두고 여기서 동기적으로 `.click()`을 호출하므로
   * 사용자 제스처(user activation)가 유지된다 — `setTimeout`으로 미루면 Safari가
   * 파일 대화상자를 막는다.
   */
  function openPhotoPicker() {
    clearStatus();
    setReview(null);
    setPanel("photo");
    coverInputRef.current?.click();
  }

  /**
   * (1) 판독 — /api/extract. 표지 흐름과 본문 흐름이 같은 처리를 쓴다.
   * 판독 실패(retake)는 예외가 아니라 정상 흐름이라 호출측에 그대로 넘긴다 (SPEC §9).
   */
  async function callExtract(
    dataUrls: string[],
  ): Promise<
    | { kind: "ok"; extraction: BookExtraction }
    | { kind: "retake"; extraction: BookExtraction | null; messageKo?: string }
    | { kind: "error"; messageKo: string }
  > {
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: dataUrls }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; reason?: string; messageKo?: string; extraction?: BookExtraction }
        | null;

      if (res.ok && data?.ok && data.extraction) return { kind: "ok", extraction: data.extraction };
      if (res.ok && data?.reason === "retake") {
        return { kind: "retake", extraction: data.extraction ?? null, messageKo: data.messageKo };
      }
      return {
        kind: "error",
        messageKo: data?.messageKo ?? "표지를 읽다가 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
      };
    } catch {
      return { kind: "error", messageKo: "서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요." };
    }
  }

  /**
   * 판독값 + 식별 결과 → /api/card 페이로드.
   * 판독 수치는 /api/card 경계 밖이면 null("미상")로 정리한다 (QA m2-1 F1):
   * 범위 밖 오독이 400 재시도 루프로 빠지는 대신 레벨 추정 경로가 흡수한다.
   */
  function buildCardPayload(
    extraction: BookExtraction,
    found: IdentifyResult | null,
  ): Record<string, unknown> {
    const arLevel = inRangeOrNull(extraction.arLevel, 0, 13);
    const lexile = inRangeOrNull(extraction.lexile, 0, 2000);
    const wordCount = inRangeOrNull(extraction.wordCount, 1, 1_000_000);
    const isFiction =
      extraction.isFiction ?? guessFictionFromCategories(found?.categories) ?? true;
    const topic = extraction.topicGuess || joinedCategories(found) || extraction.title || "";
    return {
      title: extraction.title,
      author: extraction.author ?? "",
      series: extraction.series ?? "",
      isFiction,
      arLevel,
      lexile,
      wordCount,
      arQuizNo: extraction.arQuizNo ?? "",
      topic,
      description: found?.description ?? "",
      coverEmoji: extraction.coverEmoji ?? "",
      isbn: found?.isbn ?? undefined,
      coverUrl: found?.coverUrl ?? undefined,
      googleBooksId: found?.googleBooksId ?? undefined,
      // 정리 후 값 기준 — AR 미확보(오독 강등 포함) → 레벨 추정 배지 (SPEC §3)
      levelEstimated: arLevel == null,
      // 뒤표지·책날개 소개글 — 여기서 버리면 줄거리가 3~4문장으로 줄어든다 (HARNESS §3-1)
      blurbText: extraction.blurbText ?? null,
    };
  }

  /** (2′) 본문·목차 판독 — /api/pages. 성공하면 검토 패널로 넘긴다 */
  async function runPagesStep(files: File[], kind: SceneSourceKind): Promise<boolean> {
    setPhase("pages");
    setPagesProgress({ images: files.length, batches: Math.ceil(files.length / pagesBatchSize) });

    let dataUrls: string[];
    try {
      dataUrls = await Promise.all(files.map(resizeToJpegDataUrl));
    } catch {
      fail("본문 사진을 불러오지 못했어요. 다른 사진으로 다시 시도해 주세요.", false);
      return false;
    }

    try {
      const res = await fetch("/api/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: dataUrls,
          sourceKind: kind,
          book: richContext.current ?? undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | ({ ok?: boolean; error?: string; messageKo?: string } & Partial<PagesReview>)
        | null;

      if (res.ok && data?.ok && data.scenes?.length) {
        setReview({
          sourceKind: data.sourceKind ?? kind,
          scenes: data.scenes,
          batches: data.batches ?? [],
          failedBatchCount: data.failedBatchCount ?? 0,
          messageKo: data.messageKo ?? null,
        });
        setPhase(null);
        scrollToPanel();
        return true;
      }
      // 본문 판독 실패는 카드 생성을 막지 않는다 — 검토 패널 대신 오류 패널을 띄우되,
      // 사용자가 "본문 없이 만들기"를 고를 수 있게 한다(아래 오류 패널의 보조 버튼).
      fail(
        data?.messageKo ?? "본문 사진을 읽다가 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
        res.status !== 400,
      );
      return false;
    } catch {
      fail("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.", true);
      return false;
    }
  }

  async function runRichFlow(covers: File[], pages: File[], kind: SceneSourceKind) {
    const withPages = pages.length > 0;
    setSteps(
      withPages ? ["extract", "identify", "pages", "card"] : ["extract", "identify", "card"],
    );
    setPhase("extract");
    clearStatus();
    setReview(null);
    retryAction.current = () => void runRichFlow(covers, pages, kind);

    let coverUrls: string[];
    try {
      coverUrls = await Promise.all(covers.map(resizeToJpegDataUrl));
    } catch {
      fail("표지 사진을 불러오지 못했어요. 다른 사진으로 다시 시도해 주세요.", false);
      return;
    }

    // (1) 판독
    const read = await callExtract(coverUrls);
    if (read.kind === "retake") {
      setPhase(null);
      openManualForRetake(read.extraction, read.messageKo);
      return;
    }
    if (read.kind === "error") {
      fail(read.messageKo, true);
      return;
    }
    const extraction = read.extraction;

    // (2) 식별
    setPhase("identify");
    const found = await identifyClient(extraction.title ?? "", extraction.author);

    const payload = buildCardPayload(extraction, found);
    pendingCardPayload.current = payload;
    richExtraction.current = extraction;
    pagesFlowReady.current = true;
    // 본문 판독에 넘길 책 맥락 — 제목·주제를 알면 장면 요약이 훨씬 정확해진다
    richContext.current = {
      title: String(payload.title ?? ""),
      author: (payload.author as string) || null,
      isFiction: Boolean(payload.isFiction),
      topic: String(payload.topic ?? ""),
    };

    // (2′) 본문·목차 판독 — 사진이 없으면 건너뛴다 (기본 경로와 동일해진다)
    if (!withPages) {
      await runCard(payload, {
        onInvalidInput: () =>
          openManualForRetake(
            extraction,
            "사진에서 읽은 정보로는 카드를 만들지 못했어요. 아래 내용을 확인·수정해서 만들어 주시거나, 표지를 다시 찍어 주세요.",
          ),
      });
      return;
    }
    await runPagesStep(pages, kind);
  }

  /** 검토 패널의 "본문 다시 찍기" — 판독·식별은 다시 하지 않는다 */
  async function retakePages(files: File[], kind: SceneSourceKind) {
    if (files.length === 0) return;
    clearStatus();
    setReview(null);
    setSteps(["pages", "card"]);
    retryAction.current = () => void retakePages(files, kind);
    await runPagesStep(files, kind);
  }

  /**
   * 검토 패널의 "이대로 카드 만들기" — 장면 메모를 근거로 실어 보낸다.
   *
   * 400(invalid_input)은 **같은 페이로드를 다시 보내도 똑같이 실패한다** — 재시도 버튼을
   * 띄우면 사용자가 같은 실패를 반복하게 된다(QA F12). `/api/pages`가 200으로 내려준
   * 장면이라도 `/api/card`의 길이 상한(labelKo 120자 등)에 걸릴 수 있으므로, 400은
   * "무엇을 빼면 되는지"를 알려주는 다른 출구로 보낸다:
   *   - 장면을 실어 보낸 경우 → 장면을 빼고 만들기(오류 패널의 "본문 없이 카드 만들기")
   *   - 장면 없이도 거절된 경우 → 판독값 자체 문제이므로 §9 수동 폼 폴백
   */
  async function createCardWithScenes(scenes: SceneDigestItem[] | null, kind: SceneSourceKind) {
    const base = pendingCardPayload.current;
    if (!base) return;
    const withScenes = Boolean(scenes && scenes.length > 0);
    setReview(null);
    setSteps(["card"]);
    await runCard(
      {
        ...base,
        // 근거를 여기서 빠뜨리면 storySource가 metadata로 떨어져 줄거리가 짧아진다.
        // sceneKind도 반드시 함께 — 빠지면 목차 근거가 "본문 확인"으로 오표기된다.
        ...(withScenes ? { sceneKind: kind, sceneDigest: scenes } : {}),
      },
      {
        onInvalidInput: () => {
          if (withScenes) {
            // 재시도 버튼을 띄우지 않는다(canRetry=false) — 오류 패널이 대신
            // "본문 없이 카드 만들기"를 띄우고, 아래 촬영 패널에서 다시 찍을 수도 있다.
            fail(
              "정리한 장면 메모가 카드에 담기에는 너무 길거나 형식이 맞지 않아요. 본문 없이 카드를 만들거나, 아래에서 본문을 다시 찍어 주세요.",
              false,
            );
            return;
          }
          openManualForRetake(
            richExtraction.current,
            "사진에서 읽은 정보로는 카드를 만들지 못했어요. 아래 내용을 확인·수정해서 만들어 주시거나, 표지를 다시 찍어 주세요.",
          );
        },
      },
    );
  }

  /** 판독 실패 → 수동 폼 열기 (판독으로 얻은 값이 있으면 프리필) */
  function openManualForRetake(x: BookExtraction | null, messageKo?: string) {
    setRetakeKo(
      messageKo ??
        "사진에서 책 표지를 잘 읽지 못했어요. 표지가 잘 보이게 다시 찍어 주시거나, 아래에 직접 입력해 주세요.",
    );
    setPrefill(
      x
        ? {
            title: x.title ?? "",
            author: x.author ?? "",
            series: x.series ?? "",
            isFiction: x.isFiction,
            arLevel: x.arLevel,
            lexile: x.lexile,
            wordCount: x.wordCount,
            arQuizNo: x.arQuizNo ?? "",
            topic: x.topicGuess ?? "",
            coverEmoji: x.coverEmoji ?? "",
          }
        : null,
    );
    setPrefillKey((k) => k + 1); // 폼 리마운트로 defaultValue 적용
    setPanel("manual");
    scrollToPanel();
  }

  // -------------------------------------------------------------------------
  // 흐름 2 — 책 이름: 식별 → 생성 (판독 생략, SPEC §3)
  // -------------------------------------------------------------------------

  function onTitleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = String(fd.get("title") ?? "").trim();
    const author = String(fd.get("author") ?? "").trim();
    if (!title) {
      setErrorKo("책 제목을 입력해 주세요.");
      setCanRetry(false);
      return;
    }
    void runTitleFlow(title, author);
  }

  async function runTitleFlow(title: string, author: string) {
    setSteps(["identify", "card"]);
    setPhase("identify");
    clearStatus();
    retryAction.current = () => void runTitleFlow(title, author);

    const found = await identifyClient(title, author || null);
    const isFiction = guessFictionFromCategories(found?.categories) ?? true;
    const topic = joinedCategories(found) || title;
    await runCard({
      title,
      author,
      series: "",
      isFiction,
      arLevel: null,
      lexile: null,
      wordCount: null,
      arQuizNo: "",
      topic,
      description: found?.description ?? "",
      coverEmoji: "",
      isbn: found?.isbn ?? undefined,
      coverUrl: found?.coverUrl ?? undefined,
      googleBooksId: found?.googleBooksId ?? undefined,
      // 제목만으로 시작 → AR 미확보 → 레벨 추정 (HARNESS §3-2 "미상(레벨 추정 필요)")
      levelEstimated: true,
    });
  }

  // -------------------------------------------------------------------------
  // 흐름 3 — 직접 입력(고급·§9 폴백): 식별(보강) → 생성
  // -------------------------------------------------------------------------

  function onManualSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const str = (name: string) => String(fd.get(name) ?? "").trim();
    const num = (name: string): number | null => {
      const v = str(name);
      if (!v) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const title = str("title");
    const topic = str("topic");
    const fiction = fd.get("isFiction");
    if (!title || !topic || !fiction) {
      setErrorKo("제목, 주제, 픽션/논픽션은 꼭 입력해 주세요.");
      setCanRetry(false);
      return;
    }

    const lexile = num("lexile");
    const wordCount = num("wordCount");
    void runManualFlow({
      title,
      author: str("author"),
      series: str("series"),
      isFiction: fiction === "fiction",
      arLevel: num("arLevel"),
      lexile: lexile == null ? null : Math.round(lexile),
      wordCount: wordCount == null ? null : Math.round(wordCount),
      arQuizNo: str("arQuizNo"),
      topic,
      description: str("description"),
      coverEmoji: str("coverEmoji"),
    });
  }

  async function runManualFlow(input: {
    title: string;
    author: string;
    series: string;
    isFiction: boolean;
    arLevel: number | null;
    lexile: number | null;
    wordCount: number | null;
    arQuizNo: string;
    topic: string;
    description: string;
    coverEmoji: string;
  }) {
    setSteps(["identify", "card"]);
    setPhase("identify");
    clearStatus();
    retryAction.current = () => void runManualFlow(input);

    // 수동 입력이어도 식별을 거쳐 썸네일·소개글을 보강한다 (SPEC §3 파이프라인).
    // 사용자가 쓴 소개글이 있으면 그것이 우선.
    const found = await identifyClient(input.title, input.author || null);
    await runCard({
      ...input,
      description: input.description || (found?.description ?? ""),
      isbn: found?.isbn ?? undefined,
      coverUrl: found?.coverUrl ?? undefined,
      googleBooksId: found?.googleBooksId ?? undefined,
      // levelEstimated는 서버가 arLevel 부재로 판단
    });
  }

  // -------------------------------------------------------------------------
  // 렌더링
  // -------------------------------------------------------------------------

  const activeIdx = phase ? steps.indexOf(phase) : -1;

  return (
    <section>
      {/*
       * 파일 입력 2개 — 화면에 보이지 않고 **항상 마운트**해 둔다.
       *
       * 항상 마운트하는 이유: 진입 버튼이 패널을 열면서 같은 핸들러 안에서 곧바로
       * `coverInputRef.current?.click()`을 호출해야 표지만 찍는 사람의 탭이 늘지 않는다.
       * 패널 안에만 두면 클릭 시점에 ref가 비어 있어 `setTimeout`으로 미뤄야 하는데,
       * 그러면 사용자 제스처가 끊겨 Safari가 파일 대화상자를 막는다.
       *
       * `capture`는 **절대 쓰지 않는다** — 모바일 브라우저가 카메라를 바로 열고 한 장만
       * 받으며 `multiple`을 무시한다(iOS Safari·Android Chrome 공통). 표지 3장도 본문
       * 12~16장도 보관함이 열려야 고를 수 있다. 카메라는 그 선택 시트에서 여전히 갈 수 있다.
       */}
      <input
        ref={coverInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          // 최대 3장 — 표지 / 정보 스티커 / 뒤표지 (SPEC §4-1). 상한은 lib/upload-limits가
          // 단일 정의처이고 /api/extract의 zod가 같은 값을 쓴다 (한쪽만 고치면 QA F10 재발)
          //
          // **덧붙이기**로 담는다. 카메라로 "바로 찍기"를 고르면 OS가 한 번에 한 장만
          // 돌려주므로(multiple을 줘도 그렇다 — 카메라 세션이 1장으로 끝난다), 교체로
          // 두면 표지 3장을 영영 못 채운다. 찍기를 세 번 눌러 쌓을 수 있어야 한다.
          //
          // 새로 고른 사진은 목록에 바로 넣지 않고 **자르기 큐**에 쌓는다 — 맨 앞부터
          // 자동으로 자르기 모달이 열리고, onDone이 결과를 목록에 넣는다(아래 큐 cropper).
          // 상한을 넘길 만큼은 애초에 큐에 담지 않는다(이미 담긴 것 + 큐 대기분 제외).
          const added = Array.from(e.target.files ?? []);
          e.target.value = ""; // 같은 사진을 다시 골라도 change가 발생하게
          if (added.length === 0) return;
          const remaining = Math.max(0, COVER_MAX_IMAGES - coverFiles.length - coverQueue.length);
          if (remaining === 0) return;
          clearStatus();
          setCoverQueue((q) => [...q, ...added.slice(0, remaining)]);
        }}
      />
      <input
        ref={pageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          // 이어 담기 — 보관함에서 한 번에 다 고르지 못했거나 나눠 찍은 경우를 위해
          // 기존 선택에 덧붙인다. 처음부터 다시 고르려면 "전체 지우기".
          const added = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (added.length === 0) return;
          const merged = [...pageFiles, ...added].slice(0, pagesMaxImages);
          setPageFiles(merged);
          clearStatus();
          // 이미 표지 판독이 끝난 상태(검토 패널의 "본문 다시 찍기", 또는 장면이
          // 거절된 뒤 다시 찍기)라면 표지 판독을 다시 하지 않고 본문만 재판독한다
          if (pagesFlowReady.current) void retakePages(merged, sceneKind);
        }}
      />

      {/* 큰 버튼 2개 — 이 화면의 주인공. 주요(사진)만 accent 배경 (DESIGN §5).
          사진 경로는 하나다 — 표지만 찍든 본문까지 찍든 여기서 시작한다. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={openPhotoPicker}
          disabled={busy}
          className="u-entry u-entry-primary"
        >
          <span className="u-entry-icon" aria-hidden>📷</span>
          <span className="u-entry-title">사진으로 만들기</span>
          <span className="u-entry-desc">
            표지만 찍어도 돼요. 본문·목차까지 찍으면 장면마다 질문이 붙은 읽기 가이드가
            더해져요.
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            clearStatus();
            setPanel("title");
            scrollToPanel();
          }}
          disabled={busy}
          className="u-entry u-entry-secondary"
        >
          <span className="u-entry-icon" aria-hidden>✏️</span>
          <span className="u-entry-title">책 이름으로 만들기</span>
          <span className="u-entry-desc">
            제목만 있어도 시작할 수 있어요. 책 소개와 표지는 저희가 찾아 드려요.
          </span>
        </button>
      </div>

      {/* 진행 상태 — 실제 호출 단계와 1:1 (SPEC §3).
          지난 단계·현재 단계는 파란 점, 남은 단계는 옅은 회색 점으로 단정하게. */}
      {busy && (
        <div
          role="status"
          aria-live="polite"
          className="mt-6 rounded-[var(--radius-card)] border border-line bg-bg p-5"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="t-question-ko font-medium text-ink">
              {phase ? STEP_LABEL[phase] : STEP_LABEL[steps[0]]}…
            </p>
            <p className="t-meta-chip flex-none">
              {Math.max(0, activeIdx) + 1} / {steps.length}
            </p>
          </div>

          {/* 진행 표시 — 트랙은 line, 지나온 구간만 accent (파랑 하나로) */}
          <div className="mt-3 flex gap-1.5" aria-hidden>
            {steps.map((step, i) => (
              <span
                key={step}
                className={`h-1.5 flex-1 rounded-full ${i <= activeIdx ? "bg-accent" : "bg-line"}`}
              />
            ))}
          </div>

          <ol className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
            {steps.map((step, i) => (
              <li
                key={step}
                className={`t-meta-chip ${
                  i < activeIdx ? "text-ink-2" : i === activeIdx ? "text-accent-ink" : "text-ink-3"
                }`}
              >
                {i < activeIdx ? "✓ " : ""}
                {STEP_LABEL[step]}
              </li>
            ))}
          </ol>

          {/*
           * 본문 판독은 사진 장수에 비례해 오래 걸린다(40장이면 배치 7개). 화면이
           * 멈춘 것처럼 보이면 새로고침하게 되고, 그러면 이미 쓴 비용이 날아간다.
           * 서버가 배치별 진행을 스트리밍하지 않으므로 **지어낸 퍼센트 대신** 사진
           * 장수·묶음 수와 경과 시간을 사실 그대로 보여준다.
           */}
          {phase === "pages" && pagesProgress ? (
            <p className="t-caption mt-3">
              사진 {pagesProgress.images}장을 {pagesBatchSize}장씩 {pagesProgress.batches}묶음으로
              나눠 읽고 있어요 · 경과 {elapsedSec}초
              <br />
              사진이 많으면 1~2분까지 걸릴 수 있어요. 창을 닫지 말고 기다려 주세요!
            </p>
          ) : (
            <p className="t-caption mt-3">보통 20~40초 정도 걸려요. 조금만 기다려 주세요!</p>
          )}
        </div>
      )}

      {/* 동일 책 재등록 (SPEC §9) — 기존 카드로 이동 + "그래도 새로 만들기" */}
      {!busy && duplicate && (
        <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-bg p-5 text-center">
          <p className="t-section-title">이미 이 책으로 만든 카드가 있어요 📚</p>
          <p className="t-caption mt-1">기존 카드를 볼까요, 새로 하나 더 만들까요?</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {duplicate.cardId && (
              <button
                type="button"
                onClick={() => router.push(`/card/${duplicate.cardId}`)}
                className="u-btn u-btn-primary"
              >
                기존 카드 보기
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (!lastCardPayload.current) return;
                setSteps(["card"]);
                void runCard({ ...lastCardPayload.current, force: true });
              }}
              className="u-btn u-btn-secondary"
            >
              그래도 새로 만들기
            </button>
          </div>
        </div>
      )}

      {/* 오류 패널 — 재시도는 실패한 단계부터 다시 (SPEC §9) */}
      {!busy && errorKo && (
        <div
          role="alert"
          className="u-box-accent mt-4"
        >
          <p className="t-question-ko text-ink">{errorKo}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {canRetry && (
              <button
                type="button"
                onClick={() => retryAction.current?.()}
                className="u-btn u-btn-secondary"
              >
                재시도
              </button>
            )}
            {/*
             * 본문 판독이 실패해도 카드 생성을 막지 않는다 (SPEC §9 정신) —
             * 표지·소개글 근거는 이미 확보돼 있으므로 그것만으로 카드를 만들 수 있다.
             * 줄거리가 짧아질 뿐 흐름이 끊기지는 않는다.
             */}
            {pendingCardPayload.current && (
              <button
                type="button"
                onClick={() => void createCardWithScenes(null, sceneKind)}
                className="u-btn u-btn-secondary"
              >
                본문 없이 카드 만들기
              </button>
            )}
          </div>
        </div>
      )}

      {/*
       * 검토 패널 — 본문 판독 결과를 확인하고 카드로 넘어간다 (§2-5-3).
       * 여기서 부분 실패·판독 불확실·누락을 알린다. gapBefore는 불리언이라 "몇 장면이
       * 빠졌는지"를 표현하지 못하고 마지막 배치 실패는 마커 자체가 없으므로,
       * 실패한 사진 범위는 batches로 따로 안내한다 (HARNESS §2A-5).
       */}
      {!busy && review && (
        <div ref={reviewRef} className={panelCls}>
          <h2 className="t-section-title">
            {review.sourceKind === "toc" ? "목차를 읽었어요" : "본문을 읽었어요"} 📖
          </h2>
          <p className="t-caption mt-1">
            장면 {review.scenes.length}개를 정리했어요. 내용이 이상하면 다시 찍어 주세요 —
            사진은 저장하지 않고 이 요약만 카드에 남아요.
          </p>

          {/* 부분 실패 — 어느 사진이 안 읽혔는지 범위로 알린다 */}
          {review.failedBatchCount > 0 && (
            <div className="u-box-accent mt-4">
              <p className="t-question-ko text-ink">
                ⚠️ {review.messageKo ?? "일부 사진을 읽지 못했어요."}
              </p>
              <ul className="t-caption mt-2 list-disc pl-5">
                {review.batches
                  .filter((b) => !b.ok)
                  .map((b) => (
                    <li key={b.batchIndex}>
                      {b.fromImageIndex === b.toImageIndex
                        ? `${b.fromImageIndex}번째 사진`
                        : `${b.fromImageIndex}~${b.toImageIndex}번째 사진`}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* 판독이 불확실한 장면 — 그 장면만 다시 찍으면 된다 */}
          {review.scenes.some((scene) => scene.confidence === "low") && (
            <p className="t-caption mt-3">
              🔍 흐릿하게 읽힌 장면이 있어요 (아래 &lsquo;잘 안 보임&rsquo; 표시). 그 장면만 다시
              찍어도 좋아요.
            </p>
          )}

          <ol className="mt-4 flex flex-col gap-3">
            {review.scenes.map((scene, i) => (
              <li
                key={i}
                className="rounded-[var(--radius-box)] border border-line bg-bg px-4 py-3"
              >
                {scene.gapBefore && (
                  <p className="t-caption text-ink-3">
                    ⋯ 이 사이가 비어 있어요 — 사진이 빠졌거나 순서가 바뀐 것 같아요
                  </p>
                )}
                <p className="t-meta-chip font-medium text-accent-ink">
                  {scene.labelKo}
                  {scene.confidence === "low" && <span className="text-ink-3"> · 잘 안 보임</span>}
                </p>
                <p className="t-question-ko mt-1 text-ink">{scene.summaryKo}</p>
                {scene.askKo && <p className="t-caption mt-1">💬 {scene.askKo}</p>}
              </li>
            ))}
          </ol>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void createCardWithScenes(review.scenes, review.sourceKind)}
              className="u-btn u-btn-primary"
            >
              🪄 이대로 학습 카드 만들기
            </button>
            <button
              type="button"
              onClick={() => pageInputRef.current?.click()}
              className="u-btn u-btn-secondary"
            >
              📷 본문 다시 찍기
            </button>
            <button
              type="button"
              onClick={() => void createCardWithScenes(null, review.sourceKind)}
              className="u-btn u-btn-secondary"
            >
              본문 없이 만들기
            </button>
          </div>
        </div>
      )}

      {/*
       * 패널: 사진으로 카드 만들기 — **사진 경로는 이것 하나뿐이다.**
       * 표지는 필수, 본문/목차는 선택. 본문을 안 고르면 pages 단계가 통째로 빠져
       * 예전의 "표지 사진으로 만들기"와 완전히 같은 흐름이 된다.
       */}
      {panel === "photo" && (
        <div ref={panelRef} className={`${panelCls} ${busy || duplicate || review ? "hidden" : ""}`}>
          <h2 className="t-section-title">사진으로 카드 만들기</h2>
          <p className="t-caption mt-1">
            표지만 있어도 카드가 나와요. 사진은 저장하지 않고 우리말 요약만 남아요.
          </p>

          {/* 1단계 — 표지 (필수) */}
          <div className="mt-5">
            <p className={labelCls}>1. 표지 사진 * (최대 {COVER_MAX_IMAGES}장)</p>
            <p className="t-caption mb-2">
              표지 · 정보 스티커(AR 지수) · 뒤표지 소개글 — 있는 것만 찍어도 돼요
            </p>
            <button
              type="button"
              onClick={() => coverInputRef.current?.click()}
              className="u-btn u-btn-secondary w-full"
            >
              📷 {coverFiles.length > 0 ? "표지 사진 더 담기" : "표지 사진 고르기"}
            </button>
            {coverFiles.length > 0 && (
              <p className="t-caption mt-1">
                ✓ 표지 {coverFiles.length}장 담았어요
                {coverFiles.length >= COVER_MAX_IMAGES
                  ? ` — 최대 ${COVER_MAX_IMAGES}장까지예요`
                  : " · 바로 찍기로 한 장씩 더 담을 수 있어요"}
                {" · "}
                <button
                  type="button"
                  onClick={() => {
                    setCoverFiles([]);
                    setCoverQueue([]); // 대기 중 자르기도 함께 비운다(잔여 방지)
                    clearStatus();
                    pagesFlowReady.current = false;
                    setReview(null);
                  }}
                  className="underline"
                >
                  전체 지우기
                </button>
              </p>
            )}
            {coverPreviews.length > 0 && (
              <ul className="mt-3 grid grid-cols-3 gap-2">
                {coverPreviews.map((url, i) => (
                  <li key={url} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 object URL 미리보기 */}
                    <img
                      src={url}
                      alt={`고른 표지 사진 ${i + 1}`}
                      className="aspect-square w-full rounded-[var(--radius-box)] border border-line object-cover"
                    />
                    {/* 선택 사항 — 이 장만 잘라 배경·손가락을 빼면 판독이 더 정확해요 */}
                    <button
                      type="button"
                      onClick={() => setCoverCropIndex(i)}
                      aria-label={`표지 사진 ${i + 1} 자르기`}
                      className="t-meta-chip absolute bottom-1 left-1 flex items-center gap-1 rounded-full border border-line bg-bg px-2 py-1 text-ink shadow-sm"
                    >
                      ✂️ 자르기
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 2단계 — 본문 또는 목차 (선택) */}
          <div className="mt-5">
            <p className={labelCls}>2. 본문 또는 목차 사진 (선택)</p>
            {/* 선택이라는 사실을 문장으로 한 번 더 못박는다 — 필수처럼 보이면 실패다 */}
            <p className="t-caption mb-2">
              건너뛰어도 괜찮아요. 찍으면 줄거리가 길어지고, 장면마다 그 자리에서 던질 질문이
              붙어요.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setSceneKind("pages");
                  setPageFiles([]);
                }}
                aria-pressed={sceneKind === "pages"}
                className={`t-question-ko min-h-[var(--tap-min)] flex-1 rounded-[var(--radius-box)] border px-3 ${
                  sceneKind === "pages"
                    ? "border-accent bg-accent-soft text-accent-ink"
                    : "border-line bg-bg text-ink"
                }`}
              >
                📖 본문 전체
              </button>
              <button
                type="button"
                onClick={() => {
                  setSceneKind("toc");
                  setPageFiles([]);
                }}
                aria-pressed={sceneKind === "toc"}
                className={`t-question-ko min-h-[var(--tap-min)] flex-1 rounded-[var(--radius-box)] border px-3 ${
                  sceneKind === "toc"
                    ? "border-accent bg-accent-soft text-accent-ink"
                    : "border-line bg-bg text-ink"
                }`}
              >
                📑 목차 1장
              </button>
            </div>
            <p className="t-caption mt-2">
              {sceneKind === "pages"
                ? `그림책이면 펼침면을 처음부터 순서대로 찍어 주세요 (보통 12~16장, 최대 ${pagesMaxImages}장). 사진 1장이 장면 1개가 돼요.`
                : "챕터북이면 목차 페이지만 찍으면 돼요 (1~2장). 챕터 하나가 장면 하나가 돼요."}
            </p>
            <button
              type="button"
              onClick={() => pageInputRef.current?.click()}
              className="u-btn u-btn-secondary mt-2 w-full"
            >
              {sceneKind === "toc" ? "📑 목차 사진 고르기" : "📖 본문 사진 고르기"}
              {pageFiles.length > 0 ? " (더 담기)" : ""}
            </button>
            {pageFiles.length > 0 && (
              <p className="t-caption mt-1">
                ✓ {sceneKind === "toc" ? "목차" : "본문"} {pageFiles.length}장 골랐어요 (
                {pagesBatchSize}장씩 {Math.ceil(pageFiles.length / pagesBatchSize)}묶음으로 읽어요)
                {pageFiles.length >= pagesMaxImages && ` — 최대 ${pagesMaxImages}장까지예요`}
                {" · "}
                <button
                  type="button"
                  onClick={() => {
                    setPageFiles([]);
                    clearStatus();
                  }}
                  className="underline"
                >
                  전체 지우기
                </button>
              </p>
            )}
            <p className="t-caption mt-2">
              찍은 <b>순서가 곧 장면 순서</b>예요. 순서가 섞이면 앱이 &lsquo;여기가 비어
              있어요&rsquo;라고 알려 줄 뿐, 내용을 지어내지 않아요.
            </p>
          </div>

          <button
            type="button"
            disabled={coverFiles.length === 0}
            onClick={() => void runRichFlow(coverFiles, pageFiles, sceneKind)}
            className="u-btn u-btn-primary mt-6 w-full disabled:opacity-55"
          >
            🪄 학습 카드 만들기
          </button>
          <p className="t-caption mt-2 text-center">
            {coverFiles.length === 0
              ? "표지 사진을 먼저 골라 주세요."
              : pageFiles.length === 0
                ? "표지 " + coverFiles.length + "장으로 만들어요 (본문 없이도 괜찮아요)"
                : `표지 ${coverFiles.length}장 + ${sceneKind === "toc" ? "목차" : "본문"} ${pageFiles.length}장으로 만들어요`}
          </p>
        </div>
      )}

      {/* 패널: 책 이름으로 만들기 (제목 + 저자 선택) */}
      {panel === "title" && (
        <div ref={panelRef} className={`${panelCls} ${busy || duplicate ? "hidden" : ""}`}>
          <h2 className="t-section-title">책 이름으로 만들기</h2>
          <p className="t-caption mt-1">
            제목만 적어도 돼요. 저자까지 적으면 책을 더 정확히 찾아요. AR 정보가 없으면
            레벨을 추정하고 카드에 &lsquo;레벨 추정&rsquo; 배지가 붙어요.
          </p>
          <form onSubmit={onTitleSubmit} className="mt-4 grid gap-4">
            <div>
              <label htmlFor="t-title" className={labelCls}>제목 *</label>
              <input id="t-title" name="title" required className={inputCls} placeholder="예: Wolves" />
            </div>
            <div>
              <label htmlFor="t-author" className={labelCls}>저자 (선택)</label>
              <input id="t-author" name="author" className={inputCls} placeholder="예: Laura Marsh" />
            </div>
            <button type="submit" className="u-btn u-btn-primary w-full">
              🪄 학습 카드 만들기
            </button>
          </form>
          <button
            type="button"
            onClick={() => {
              setPanel("manual");
              scrollToPanel();
            }}
            className="t-meta-chip mt-3 inline-block py-2 text-ink-2 underline underline-offset-2"
          >
            AR 지수·주제까지 알고 있어요 — 직접 입력하기
          </button>
        </div>
      )}

      {/* 패널: 직접 입력 (전체 폼 — 고급 입력이자 §9 판독 실패 폴백) */}
      {panel === "manual" && (
        <div ref={panelRef} className={`${panelCls} ${busy || duplicate ? "hidden" : ""}`}>
          {/* 판독 실패 안내 (SPEC §9 "다시 찍어주세요") */}
          {retakeKo && (
            <div className="u-box-accent mb-4">
              <p className="t-question-ko text-ink">📷 {retakeKo}</p>
              {/* 판독 실패 → 다시 찍기. 사진 경로가 하나뿐이라 진입점도 하나다 */}
              <button type="button" onClick={openPhotoPicker} className="u-btn u-btn-secondary mt-3">
                다시 찍기
              </button>
            </div>
          )}

          <h2 className="t-section-title">책 정보 직접 입력</h2>
          <p className="t-caption mt-1">
            제목·주제·픽션 여부만 필수예요. AR 같은 정보는 책 뒤 정보 스티커에 있으면 함께
            적어 주세요 — 카드가 더 정확해져요.
          </p>

          {/* 폼은 로딩·중복 중에도 언마운트하지 않는다(위 컨테이너 hidden) — 입력값 보존.
              prefillKey 리마운트는 판독 실패 프리필을 적용할 때만 일어난다. */}
          <form key={prefillKey} onSubmit={onManualSubmit} className="mt-4 grid gap-4">
            <div>
              <label htmlFor="f-title" className={labelCls}>제목 *</label>
              <input
                id="f-title"
                name="title"
                required
                className={inputCls}
                placeholder="예: Wolves"
                defaultValue={prefill?.title ?? ""}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="f-author" className={labelCls}>저자</label>
                <input
                  id="f-author"
                  name="author"
                  className={inputCls}
                  placeholder="예: Laura Marsh"
                  defaultValue={prefill?.author ?? ""}
                />
              </div>
              <div>
                <label htmlFor="f-series" className={labelCls}>시리즈</label>
                <input
                  id="f-series"
                  name="series"
                  className={inputCls}
                  placeholder="예: National Geographic Kids Readers"
                  defaultValue={prefill?.series ?? ""}
                />
              </div>
            </div>

            <fieldset>
              <legend className={labelCls}>어떤 책인가요? *</legend>
              <div className="flex gap-2">
                <label className="t-question-ko flex min-h-[var(--tap-min)] flex-1 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-box)] border border-line bg-bg px-3 text-ink has-checked:border-accent has-checked:bg-accent-soft">
                  <input
                    type="radio"
                    name="isFiction"
                    value="fiction"
                    className="accent-accent"
                    defaultChecked={prefill?.isFiction === true}
                  />
                  📖 픽션
                </label>
                <label className="t-question-ko flex min-h-[var(--tap-min)] flex-1 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-box)] border border-line bg-bg px-3 text-ink has-checked:border-accent has-checked:bg-accent-soft">
                  <input
                    type="radio"
                    name="isFiction"
                    value="nonfiction"
                    className="accent-accent"
                    defaultChecked={prefill?.isFiction === false}
                  />
                  🔬 논픽션
                </label>
              </div>
              <p className="t-caption mt-2">이야기 책이면 픽션, 정보를 알려주는 책이면 논픽션이에요.</p>
            </fieldset>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <label htmlFor="f-ar" className={labelCls}>AR 지수</label>
                <input
                  id="f-ar"
                  name="arLevel"
                  type="number"
                  step="0.1"
                  min="0"
                  max="13"
                  inputMode="decimal"
                  className={inputCls}
                  placeholder="3.3"
                  defaultValue={prefill?.arLevel ?? ""}
                />
              </div>
              <div>
                <label htmlFor="f-lexile" className={labelCls}>Lexile</label>
                <input
                  id="f-lexile"
                  name="lexile"
                  type="number"
                  step="1"
                  min="0"
                  inputMode="numeric"
                  className={inputCls}
                  placeholder="570"
                  defaultValue={prefill?.lexile ?? ""}
                />
              </div>
              <div>
                <label htmlFor="f-wc" className={labelCls}>단어 수</label>
                <input
                  id="f-wc"
                  name="wordCount"
                  type="number"
                  step="1"
                  min="1"
                  inputMode="numeric"
                  className={inputCls}
                  placeholder="864"
                  defaultValue={prefill?.wordCount ?? ""}
                />
              </div>
              <div>
                <label htmlFor="f-quiz" className={labelCls}>AR 퀴즈번호</label>
                <input
                  id="f-quiz"
                  name="arQuizNo"
                  className={inputCls}
                  placeholder="148832"
                  defaultValue={prefill?.arQuizNo ?? ""}
                />
              </div>
            </div>
            <p className="t-caption -mt-2">
              AR을 비워 두면 주제·소개글로 레벨을 추정하고 카드에 &lsquo;레벨 추정&rsquo; 배지가 붙어요.
            </p>

            <div>
              <label htmlFor="f-topic" className={labelCls}>주제 *</label>
              <input
                id="f-topic"
                name="topic"
                required
                className={inputCls}
                placeholder="예: 늑대 — 무리 생활, 하울링, 사냥, 새끼 키우기"
                defaultValue={prefill?.topic ?? ""}
              />
            </div>

            <div>
              <label htmlFor="f-desc" className={labelCls}>소개글 (출판사 공개 소개 등)</label>
              <textarea
                id="f-desc"
                name="description"
                rows={3}
                className={inputCls}
                placeholder="비워 두면 Google Books에서 공개 소개글을 찾아볼게요 (선택)"
              />
            </div>

            <div>
              <label htmlFor="f-emoji" className={labelCls}>커버 이모지</label>
              <input
                id="f-emoji"
                name="coverEmoji"
                className={inputCls}
                placeholder="🐺 (비워 두면 📖)"
                defaultValue={prefill?.coverEmoji ?? ""}
              />
            </div>

            <button type="submit" className="u-btn u-btn-primary w-full">
              🪄 학습 카드 만들기
            </button>
          </form>
        </div>
      )}

      {/*
       * 자르기 모달 — 두 진입.
       * (1) **큐**: 새로 고른 표지. 목록에 넣기 전에 한 장씩 자동으로 연다.
       *     onDone → 결과를 목록에 추가(상한 슬라이스) + 판독 무효화 + 큐 한 칸 당김.
       *     취소 → 그 장만 버리고 큐 한 칸 당김(파일 유실 OK — 다시 고르면 된다).
       * (2) **다시 자르기**: 이미 담긴 표지의 썸네일 "✂️ 자르기". replaceCover로 교체.
       * 큐가 우선한다(새 사진을 다 처리한 뒤에야 다시 자르기 모달이 뜬다).
       */}
      {coverQueue[0] ? (
        <ImageCropper
          file={coverQueue[0]}
          onDone={(result) => {
            setCoverFiles((prev) => [...prev, result].slice(0, COVER_MAX_IMAGES));
            // 표지가 늘면 판독 결과가 무효다 — 원래 "표지 담기"와 같은 무효화(§ replaceCover와 동일)
            pagesFlowReady.current = false;
            setReview(null);
            setCoverQueue((q) => q.slice(1));
            scrollToPanel();
          }}
          onCancel={() => setCoverQueue((q) => q.slice(1))}
        />
      ) : coverCropIndex != null && coverFiles[coverCropIndex] ? (
        <ImageCropper
          file={coverFiles[coverCropIndex]}
          onDone={(result) => {
            replaceCover(coverCropIndex, result); // 자른 결과(또는 "전체 사용" 원본)로 그 표지를 교체
            setCoverCropIndex(null);
          }}
          onCancel={() => setCoverCropIndex(null)}
        />
      ) : null}
    </section>
  );
}

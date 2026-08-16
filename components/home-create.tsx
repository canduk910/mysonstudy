"use client";

/**
 * 홈의 카드 만들기 영역 (SPEC §4-1, M2) — 클라이언트 컴포넌트.
 *
 * 세 가지 입력 흐름 — 진행 UI가 실제 호출 단계와 1:1로 일치한다 (SPEC §3):
 * - 표지 사진: 판독(/api/extract) → 식별(/api/identify) → 생성(/api/card)
 *   = "표지 읽는 중 → 책 확인 중 → 카드 만드는 중".
 *   판독 실패(retake)는 §9 폴백: 안내 + 수동 폼(판독된 값이 있으면 프리필).
 * - 책 이름: 제목(+저자 선택)만으로 시작 — 판독 생략, 식별 → 생성.
 *   AR 미확보이므로 levelEstimated=true (카드에 "레벨 추정" 배지, HARNESS §3-2).
 * - 직접 입력(고급·§9 폴백): M1의 전체 메타데이터 폼 유지. 제출 시에도 식별을
 *   거쳐 썸네일·소개글을 보강한다(사용자가 쓴 소개글이 우선).
 *
 * 사진은 클라이언트에서 canvas로 긴 변 ~1500px JPEG로 리사이즈해 보낸다
 * (토큰 절약 — ai-harness-impl 스킬 권장). 서버는 판독 후 사진을 저장하지 않는다(SPEC §5).
 */

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { BookExtraction } from "@/lib/ai/schemas";
import type { IdentifyResult } from "@/lib/identify";

// ---------------------------------------------------------------------------
// 타입·상수
// ---------------------------------------------------------------------------

type StepId = "extract" | "identify" | "card";

/** 진행 UI 문구 (SPEC §3) — 단계 id가 곧 실제 API 호출이다 */
const STEP_LABEL: Record<StepId, string> = {
  extract: "표지 읽는 중",
  identify: "책 확인 중",
  card: "카드 만드는 중",
};

interface DuplicateInfo {
  bookId: string;
  cardId: string | null;
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

const MAX_IMAGE_EDGE = 1500;
const JPEG_QUALITY = 0.85;

const inputCls =
  "w-full rounded-xl border border-line bg-white px-3 py-2.5 text-[15px] text-ink outline-none focus:border-fiction";
const labelCls = "block text-[13px] font-semibold text-sub mb-1";

// ---------------------------------------------------------------------------
// 사진 리사이즈 (canvas — 긴 변 ~1500px, JPEG)
// ---------------------------------------------------------------------------

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 불러오지 못했어요"));
    };
    img.src = url;
  });
}

async function resizeToJpegDataUrl(file: File): Promise<string> {
  const img = await loadImage(file);
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(1, longEdge));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 사용 불가");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

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

export default function HomeCreate() {
  const router = useRouter();

  /** 열려 있는 입력 패널 — title(제목만) / manual(전체 폼, 고급·폴백) */
  const [panel, setPanel] = useState<"none" | "title" | "manual">("none");
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

  const lastCardPayload = useRef<Record<string, unknown> | null>(null);
  /** 오류 패널의 "재시도"가 다시 실행할 동작 (실패한 단계부터) */
  const retryAction = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const busy = phase !== null;

  function clearStatus() {
    setErrorKo(null);
    setCanRetry(false);
    setDuplicate(null);
    setRetakeKo(null);
  }

  function scrollToPanel() {
    setTimeout(
      () => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
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
  // 흐름 1 — 표지 사진: 판독 → 식별 → 생성
  // -------------------------------------------------------------------------

  function onPickPhotos() {
    clearStatus();
    fileInputRef.current?.click();
  }

  async function onFilesSelected(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, 2); // 최대 2장 (SPEC §4-1)
    e.target.value = ""; // 같은 사진을 다시 골라도 change가 발생하게
    if (files.length === 0) return;
    clearStatus();
    setPanel("none");
    setSteps(["extract", "identify", "card"]);
    setPhase("extract"); // 리사이즈도 사용자에겐 "표지 읽는 중"의 일부
    let dataUrls: string[];
    try {
      dataUrls = await Promise.all(files.map(resizeToJpegDataUrl));
    } catch {
      setPhase(null);
      setErrorKo("사진을 불러오지 못했어요. 다른 사진으로 다시 시도해 주세요.");
      setCanRetry(false);
      return;
    }
    await runPhotoFlow(dataUrls);
  }

  async function runPhotoFlow(dataUrls: string[]) {
    setSteps(["extract", "identify", "card"]);
    setPhase("extract");
    clearStatus();
    retryAction.current = () => void runPhotoFlow(dataUrls);

    // (1) 판독
    let extraction: BookExtraction;
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: dataUrls }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; reason?: string; messageKo?: string; extraction?: BookExtraction }
        | null;

      if (res.ok && data?.ok && data.extraction) {
        extraction = data.extraction;
      } else if (res.ok && data?.reason === "retake") {
        // 판독 실패는 정상 흐름 (SPEC §9): 안내 + 수동 폼 폴백 (부분 판독값 프리필)
        setPhase(null);
        openManualForRetake(data.extraction ?? null, data.messageKo);
        return;
      } else {
        setPhase(null);
        setErrorKo(data?.messageKo ?? "표지를 읽다가 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
        setCanRetry(true);
        return;
      }
    } catch {
      setPhase(null);
      setErrorKo("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
      setCanRetry(true);
      return;
    }

    // (2) 식별 — 실패해도 진행 (커버는 이모지)
    setPhase("identify");
    const found = await identifyClient(extraction.title ?? "", extraction.author);

    // (3) 생성 — 판독값 + 식별 결과 병합.
    // 판독 수치는 /api/card 경계 밖이면 null("미상")로 정리해 전달한다 (QA F1):
    // 범위 밖 오독이 400 재시도 루프로 빠지는 대신 레벨 추정 경로가 흡수한다.
    const arLevel = inRangeOrNull(extraction.arLevel, 0, 13);
    const lexile = inRangeOrNull(extraction.lexile, 0, 2000);
    const wordCount = inRangeOrNull(extraction.wordCount, 1, 1_000_000);
    const isFiction =
      extraction.isFiction ?? guessFictionFromCategories(found?.categories) ?? true;
    const topic = extraction.topicGuess || joinedCategories(found) || extraction.title || "";
    await runCard(
      {
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
      },
      {
        // 사진 흐름에는 열린 폼이 없다 — 남은 400(빈 제목·너무 긴 값 등)은
        // §9 수동 폼 폴백으로 연결해 판독값을 프리필한다 (QA F1 보조안).
        // 서버 messageKo("입력 내용을 확인해 주세요.")보다 사진 맥락 안내가 낫다.
        onInvalidInput: () =>
          openManualForRetake(
            extraction,
            "사진에서 읽은 정보로는 카드를 만들지 못했어요. 아래 내용을 확인·수정해서 만들어 주시거나, 표지를 다시 찍어 주세요.",
          ),
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
      {/* 숨긴 파일 입력 (SPEC §4-1 — image/*, 후면 카메라, 최대 2장) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={onFilesSelected}
        className="hidden"
        tabIndex={-1}
        aria-hidden
      />

      {/* 큰 버튼 2개 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={onPickPhotos}
          disabled={busy}
          className="rounded-2xl border-2 border-nonfiction/50 bg-card p-5 text-left shadow-sm transition hover:border-nonfiction hover:shadow disabled:opacity-60"
        >
          <span className="text-3xl" aria-hidden>📷</span>
          <span className="mt-2 block text-lg font-bold text-ink">표지 사진으로 만들기</span>
          <span className="mt-1 block text-[13px] leading-snug text-sub">
            책 표지를 찍어 주세요. 정보 스티커(AR 지수)가 있으면 그 사진까지 최대 2장!
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
          className="rounded-2xl border-2 border-fiction/50 bg-card p-5 text-left shadow-sm transition hover:border-fiction hover:shadow disabled:opacity-60"
        >
          <span className="text-3xl" aria-hidden>✏️</span>
          <span className="mt-2 block text-lg font-bold text-ink">책 이름으로 만들기</span>
          <span className="mt-1 block text-[13px] leading-snug text-sub">
            제목만 있어도 시작할 수 있어요. 책 소개와 표지는 저희가 찾아 드려요.
          </span>
        </button>
      </div>

      {/* 진행 상태 — 실제 호출 단계와 1:1 (SPEC §3) */}
      {busy && (
        <div className="mt-6 rounded-2xl border border-line bg-card p-6 text-center">
          <ol className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
            {steps.map((step, i) => (
              <li key={step} className="flex items-center gap-2 text-[14px]">
                <span
                  className={
                    i < activeIdx
                      ? "font-semibold text-sub"
                      : i === activeIdx
                        ? "font-bold text-ink"
                        : "text-sub/60"
                  }
                >
                  <span aria-hidden>{i < activeIdx ? "✅" : i === activeIdx ? "⏳" : "○"}</span>{" "}
                  {STEP_LABEL[step]}
                </span>
                {i < steps.length - 1 && (
                  <span className="text-sub/50" aria-hidden>→</span>
                )}
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[13px] text-sub">
            보통 20~40초 정도 걸려요. 조금만 기다려 주세요!
          </p>
        </div>
      )}

      {/* 동일 책 재등록 (SPEC §9) — 기존 카드로 이동 + "그래도 새로 만들기" */}
      {!busy && duplicate && (
        <div className="mt-6 rounded-2xl border border-line bg-card p-6 text-center">
          <p className="text-base font-bold text-ink">이미 이 책으로 만든 카드가 있어요 📚</p>
          <p className="mt-1 text-[13px] text-sub">기존 카드를 볼까요, 새로 하나 더 만들까요?</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {duplicate.cardId && (
              <button
                type="button"
                onClick={() => router.push(`/card/${duplicate.cardId}`)}
                className="rounded-xl bg-fiction px-4 py-2.5 text-[14px] font-bold text-white"
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
              className="rounded-xl border border-line bg-white px-4 py-2.5 text-[14px] font-semibold text-ink"
            >
              그래도 새로 만들기
            </button>
          </div>
        </div>
      )}

      {/* 오류 패널 — 재시도는 실패한 단계부터 다시 (SPEC §9) */}
      {!busy && errorKo && (
        <div className="mt-4 rounded-xl border border-fiction/40 bg-fiction/10 px-4 py-3 text-[13.5px] text-ink">
          <p>{errorKo}</p>
          {canRetry && (
            <button
              type="button"
              onClick={() => retryAction.current?.()}
              className="mt-2 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-semibold"
            >
              재시도
            </button>
          )}
        </div>
      )}

      {/* 패널: 책 이름으로 만들기 (제목 + 저자 선택) */}
      {panel === "title" && (
        <div
          ref={panelRef}
          className={`mt-6 rounded-2xl border border-line bg-card p-5 sm:p-6 ${busy || duplicate ? "hidden" : ""}`}
        >
          <h2 className="text-lg font-bold text-ink">책 이름으로 만들기</h2>
          <p className="mt-1 text-[13px] text-sub">
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
            <button
              type="submit"
              className="rounded-xl bg-fiction px-4 py-3 text-base font-bold text-white shadow-sm transition hover:brightness-105"
            >
              🪄 학습 카드 만들기
            </button>
          </form>
          <button
            type="button"
            onClick={() => {
              setPanel("manual");
              scrollToPanel();
            }}
            className="mt-3 text-[13px] font-semibold text-sub underline underline-offset-2"
          >
            AR 지수·주제까지 알고 있어요 — 직접 입력하기
          </button>
        </div>
      )}

      {/* 패널: 직접 입력 (전체 폼 — 고급 입력이자 §9 판독 실패 폴백) */}
      {panel === "manual" && (
        <div
          ref={panelRef}
          className={`mt-6 rounded-2xl border border-line bg-card p-5 sm:p-6 ${busy || duplicate ? "hidden" : ""}`}
        >
          {/* 판독 실패 안내 (SPEC §9 "다시 찍어주세요") */}
          {retakeKo && (
            <div className="mb-4 rounded-xl border border-nonfiction/40 bg-nonfiction/10 px-4 py-3 text-[13.5px] text-ink">
              <p>📷 {retakeKo}</p>
              <button
                type="button"
                onClick={onPickPhotos}
                className="mt-2 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-semibold"
              >
                다시 찍기
              </button>
            </div>
          )}

          <h2 className="text-lg font-bold text-ink">책 정보 직접 입력</h2>
          <p className="mt-1 text-[13px] text-sub">
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
                <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] font-semibold text-ink has-checked:border-fiction has-checked:bg-fiction/10">
                  <input
                    type="radio"
                    name="isFiction"
                    value="fiction"
                    className="accent-fiction"
                    defaultChecked={prefill?.isFiction === true}
                  />
                  📖 픽션 (이야기 책)
                </label>
                <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] font-semibold text-ink has-checked:border-nonfiction has-checked:bg-nonfiction/10">
                  <input
                    type="radio"
                    name="isFiction"
                    value="nonfiction"
                    className="accent-nonfiction"
                    defaultChecked={prefill?.isFiction === false}
                  />
                  🔬 논픽션 (정보 책)
                </label>
              </div>
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
            <p className="-mt-2 text-[12px] text-sub">
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

            <button
              type="submit"
              className="rounded-xl bg-fiction px-4 py-3 text-base font-bold text-white shadow-sm transition hover:brightness-105"
            >
              🪄 학습 카드 만들기
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

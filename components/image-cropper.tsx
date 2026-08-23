"use client";

/**
 * components/image-cropper.tsx — 사진 자르기 모달 (클라이언트 전용, 공유 컴포넌트)
 *
 * 영어 표지·수학 문제집·영어 단어장 세 화면이 **같은 이 모달**을 쓴다. 파일 하나를 받아
 * 캔버스에 축소해 그리고, **사진 위에 조절 가능한 박스**를 얹어 네 구석·네 모서리 손잡이로
 * 크기를 줄이거나 박스 안쪽을 끌어 옮긴 뒤, 그 영역만 잘라낸 `File`을 돌려준다.
 * 좌표 변환·자르기는 `lib/image-crop.ts`의 순수 함수에 있고, 이 파일은 그 함수를 캔버스·
 * pointer 이벤트에 배선한다. 라이브러리 0(브라우저 canvas·pointer만).
 *
 * 표준 크롭 조작(사진마다 자동으로 열리고, 처음엔 박스가 사진 전체 → 안으로 당겨 줄임):
 * - 초기 선택 = 사진 전체(실수로 너무 작게 자르는 사고를 막는다).
 * - 손잡이 8개 — 구석(4)은 양축, 모서리 중점(4)은 한 축, 박스 안쪽 드래그는 이동.
 *   전부 `clampRect`로 캔버스 경계 안에 가둔다. 종횡비 고정 없음(자유 비율).
 * - 모바일: 손잡이 히트 영역을 넉넉히(44px), `setPointerCapture`로 드래그 안정화,
 *   `touch-action:none`으로 페이지 스크롤 가로채임 방지.
 * - 선택 밖은 딤(마스크)으로 어둡게 — 남길 영역이 한눈에 보인다.
 *
 * 자르기 목적: 배경·손가락·옆 페이지를 잘라내 판독 정확도를 높인다. "전체 사용"은 원본 File을
 * 그대로 돌려주므로(재인코딩 없음) 무크롭 경로와 바이트 동일하다 — 자르기를 안 써도 기능이
 * 막히지 않는다. 그 위에 `role="dialog"`·ESC·포커스 트랩 정도만 얹는다.
 *
 * `lib/ai/*`는 import하지 않는다(번들 오염). 새 CSS 파일 없이 `u-*`·`t-*` 토큰과 Tailwind
 * 유틸만 쓰고, 캔버스·딤·손잡이만 인라인 스타일을 최소로 쓴다. 보호자 호칭은 "엄빠".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadImage } from "@/lib/image-resize";
import {
  clampRect,
  cropImageFile,
  rotateImageFile,
  toSourceRect,
  type CropRect,
  type Size,
} from "@/lib/image-crop";
import { lockBodyScroll } from "@/lib/scroll-lock";

interface Props {
  file: File;
  /** 잘린 파일. "전체 사용"이면 원본 그대로 돌려준다. */
  onDone: (result: File) => void;
  onCancel: () => void;
}

/** 손잡이 id — 네 구석 + 네 모서리 중점. 문자에 든 방위가 곧 움직이는 변이다. */
type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** 손잡이 터치 히트 영역(px) — 시각 크기는 작아도 손가락으로 잡기 쉽게 넉넉히 둔다. */
const HIT = 44;
/** 손잡이 보이는 점 크기(px). */
const DOT = 16;
/**
 * 드래그로 줄일 수 있는 박스의 최소 표시 크기(px). 이 값이 곧 "너무 작게" 가드다 —
 * 손잡이가 반대 변을 넘어가거나 박스가 퇴화(0)되는 것을 리사이즈 단계에서 원천 차단한다.
 */
const MIN_GAP = 24;
/** 선택 밖을 덮는 딤 색 — Canvas 스크림처럼 고정값이 강제된다(테마 토큰 대상 아님). */
const MASK = "rgba(0,0,0,0.45)";

/** 손잡이 메타 — 모서리(edge)를 먼저, 구석(corner)을 뒤에 둬 겹칠 때 구석이 위로 온다. */
const HANDLES: { id: HandleId; cursor: string; cx: (s: CropRect) => number; cy: (s: CropRect) => number }[] = [
  { id: "n", cursor: "ns-resize", cx: (s) => s.x + s.width / 2, cy: (s) => s.y },
  { id: "e", cursor: "ew-resize", cx: (s) => s.x + s.width, cy: (s) => s.y + s.height / 2 },
  { id: "s", cursor: "ns-resize", cx: (s) => s.x + s.width / 2, cy: (s) => s.y + s.height },
  { id: "w", cursor: "ew-resize", cx: (s) => s.x, cy: (s) => s.y + s.height / 2 },
  { id: "nw", cursor: "nwse-resize", cx: (s) => s.x, cy: (s) => s.y },
  { id: "ne", cursor: "nesw-resize", cx: (s) => s.x + s.width, cy: (s) => s.y },
  { id: "se", cursor: "nwse-resize", cx: (s) => s.x + s.width, cy: (s) => s.y + s.height },
  { id: "sw", cursor: "nesw-resize", cx: (s) => s.x, cy: (s) => s.y + s.height },
];

/** 표시 캔버스 크기 계산 — 긴 변을 화면 폭에 맞추되 세로도 화면 높이를 넘지 않게 축소. */
function fitDisplay(nat: Size): Size {
  // 360px 화면에서도 동작해야 한다 — 좌우 여백을 넉넉히 빼고 상한을 둔다.
  const vw = typeof window !== "undefined" ? window.innerWidth : 400;
  const vh = typeof window !== "undefined" ? window.innerHeight : 700;
  const maxW = Math.min(vw - 48, 560);
  const maxH = Math.min(vh * 0.6, 640);
  const ratio = nat.height / Math.max(1, nat.width);
  let w = Math.max(1, maxW);
  let h = w * ratio;
  if (h > maxH) {
    h = maxH;
    w = h / Math.max(0.0001, ratio);
  }
  return { width: Math.round(w), height: Math.round(h) };
}

/** 선택이 자를 만큼 큰가 — MIN_GAP 드래그 바닥이 있어 보통 항상 참이지만, 활성 가드로 남긴다. */
function isCroppable(sel: CropRect | null): boolean {
  return sel != null && sel.width >= 8 && sel.height >= 8;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 손잡이 리사이즈 — 잡은 손잡이가 담당하는 변만 pointer 위치로 옮기고, 반대 변과
 * MIN_GAP 이상 벌어지도록·경계 안에 있도록 가둔다(인버전·퇴화 차단). 마지막에 순수
 * 함수 `clampRect`로 한 번 더 경계에 맞춘다(재사용).
 */
function resizeSel(base: CropRect, id: HandleId, px: number, py: number, bounds: Size): CropRect {
  let left = base.x;
  let top = base.y;
  let right = base.x + base.width;
  let bottom = base.y + base.height;
  if (id.includes("w")) left = clampNum(px, 0, right - MIN_GAP);
  if (id.includes("e")) right = clampNum(px, left + MIN_GAP, bounds.width);
  if (id.includes("n")) top = clampNum(py, 0, bottom - MIN_GAP);
  if (id.includes("s")) bottom = clampNum(py, top + MIN_GAP, bounds.height);
  return clampRect({ x: left, y: top, width: right - left, height: bottom - top }, bounds);
}

export default function ImageCropper({ file, onDone, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  /** 진행 중인 드래그 — mode(이동/손잡이)·pointerId·시작 시점 박스·이동 오프셋. */
  const dragRef = useRef<{
    mode: "move" | HandleId;
    pointerId: number;
    base: CropRect;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  const [nat, setNat] = useState<Size | null>(null);
  const [displaySize, setDisplaySize] = useState<Size | null>(null);
  const [sel, setSel] = useState<CropRect | null>(null); // 표시 캔버스 좌표
  const [cropping, setCropping] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // 크롭 전 90° 회전 — 세로 페이지를 가로로 찍은 사진을 똑바로 세운다. 0/90/180/270.
  const [rotation, setRotation] = useState(0);
  // 회전이 반영된 **실제 크롭 대상**. rotation=0이면 원본 file 그대로(재인코딩 없음 → "전체 사용" 바이트 동등).
  const [workingFile, setWorkingFile] = useState(file);

  // 새 파일(큐의 다음 장·다시 자르기)로 바뀌면 회전을 0으로 리셋하고 대상도 원본으로 되돌린다.
  useEffect(() => {
    setRotation(0);
    setWorkingFile(file);
  }, [file]);

  // 회전이 걸리면 원본에서 그 각도로 회전한 파일을 만들어 크롭 대상으로 삼는다.
  useEffect(() => {
    let cancelled = false;
    // rotation=0 = 원본 그대로. 사이클이 0으로 돌아올 때(0→90→180→270→0) 직전 회전본이 남지 않게
    // **반드시** 원본으로 되돌린다. 빠르게 눌러 이전 회전 async가 취소돼도 여기서 동기적으로 원본을
    // 세팅하므로 "원본 차례에 엉뚱한 각도"가 남는 버그가 없다.
    if (rotation === 0) {
      setWorkingFile(file);
      return () => {
        cancelled = true;
      };
    }
    rotateImageFile(file, rotation)
      .then((wf) => {
        if (!cancelled) setWorkingFile(wf);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file, rotation]);

  // 1) 이미지 로딩 (loadImage 재사용) — **workingFile**(회전 반영)의 픽셀 크기를 잡는다.
  useEffect(() => {
    let cancelled = false;
    // workingFile이 바뀌면(새 파일·회전) 이전 조작 상태를 전부 초기화한다.
    // handleCrop 성공 시 cropping을 내리지 않으므로, 큐(단어장·표지 여러 장)가 같은 cropper
    // 인스턴스에 file prop만 바꿔 다음 장으로 이어질 때 cropping=true가 남으면 버튼이 잠기고
    // 오버레이가 사라져 다음 장을 못 자른다. sel·displaySize·nat도 비워 이전 박스가 새 사진
    // 위에 잠깐 얹히는 것을 막는다(새 이미지 로드까지 "불러오는 중"). 회전 후에도 박스는 전체로 리셋된다.
    setCropping(false);
    setLoadError(false);
    setSel(null);
    setDisplaySize(null);
    setNat(null);
    loadImage(workingFile)
      .then((img) => {
        if (cancelled) return;
        imgRef.current = img;
        setNat({ width: img.naturalWidth, height: img.naturalHeight });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workingFile]);

  // 2) 표시 크기 계산 + 초기 선택 = 사진 전체. 로딩 후 + 화면 회전/리사이즈마다.
  useEffect(() => {
    if (!nat) return;
    const compute = () => {
      const ds = fitDisplay(nat);
      setDisplaySize(ds);
      // 초기 박스는 사진 전체 — 사용자가 구석을 안으로 당겨 줄인다(실수 크롭 방지).
      // 화면이 바뀌면 이전 좌표가 무의미하므로 다시 전체로 리셋한다.
      setSel({ x: 0, y: 0, width: ds.width, height: ds.height });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [nat]);

  // 3) 캔버스에 이미지만 그린다 — 딤·테두리·손잡이는 오버레이 div가 맡는다(sel 변경에
  //    캔버스를 다시 그리지 않아 드래그가 가볍다). DPR로 선명하게.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !displaySize) return;
    const { width: w, height: h } = displaySize;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
  }, [displaySize]);

  useEffect(() => {
    draw();
  }, [draw]);

  // 4) pointer 드래그 — 좌표는 캔버스(테두리 없는 콘텐츠 박스) 기준으로 재는 게 정확하다.
  function pointFromEvent(e: React.PointerEvent): { x: number; y: number } {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function startDrag(e: React.PointerEvent, mode: "move" | HandleId) {
    if (!displaySize || !sel || cropping) return;
    e.preventDefault();
    e.stopPropagation();
    // 잡은 손잡이(또는 이동면)에 pointer를 붙들어 캔버스 밖으로 나가도 드래그가 이어진다.
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = pointFromEvent(e);
    dragRef.current = {
      mode,
      pointerId: e.pointerId,
      base: sel,
      offsetX: p.x - sel.x,
      offsetY: p.y - sel.y,
    };
  }

  function onDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || !displaySize || e.pointerId !== d.pointerId) return;
    const p = pointFromEvent(e);
    if (d.mode === "move") {
      // 박스 크기는 유지하고 위치만 옮긴다 — 경계 안에 완전히 들어오게 가둔다.
      const w = d.base.width;
      const h = d.base.height;
      setSel({
        x: clampNum(p.x - d.offsetX, 0, displaySize.width - w),
        y: clampNum(p.y - d.offsetY, 0, displaySize.height - h),
        width: w,
        height: h,
      });
    } else {
      setSel(resizeSel(d.base, d.mode, p.x, p.y, displaySize));
    }
  }

  function onDragEnd(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  }

  // 5) 자르기 실행 — 표시 좌표 sel을 원본 픽셀로 옮겨(toSourceRect) cropImageFile에 넘긴다.
  async function handleCrop() {
    if (!displaySize || !nat || !isCroppable(sel) || !sel) return;
    setCropping(true);
    try {
      const sourceRect = toSourceRect(sel, displaySize, nat);
      const result = await cropImageFile(workingFile, sourceRect);
      onDone(result);
    } catch {
      setCropping(false);
      setLoadError(true);
    }
  }

  // 6) ESC 취소 + 포커스 트랩 + 바디 스크롤 잠금.
  useEffect(() => {
    const prevActive = document.activeElement as HTMLElement | null;
    const unlock = lockBodyScroll(); // 공용 ref-count 락 — 드로어 등과 중첩돼도 안 샌다
    dialogRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unlock();
      prevActive?.focus?.();
    };
  }, [onCancel]);

  const ready = !!displaySize && !loadError;
  const w = displaySize?.width ?? 0;
  const h = displaySize?.height ?? 0;
  const showOverlay = ready && !!sel && !cropping;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onPointerDown={(e) => {
        // 스크림(카드 바깥)을 누르면 취소 — 카드 안쪽 클릭은 막는다.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="사진 자르기"
        tabIndex={-1}
        className="u-box flex max-h-[90vh] w-full max-w-[600px] flex-col overflow-auto bg-bg outline-none"
      >
        <p className="t-section-title">✂️ 필요한 부분만 남겨요</p>
        <p className="t-caption mt-1">
          네 <strong>구석</strong>과 <strong>모서리</strong>를 끌어 박스를 줄이고, 박스 안쪽을 끌어
          옮겨요. 배경·손가락·옆 페이지를 빼면 더 잘 읽혀요. 통째로 쓰려면 <strong>전체 사용</strong>을
          눌러도 돼요.
        </p>

        <div className="mt-4 flex items-center justify-center">
          {loadError ? (
            <p className="t-question-ko text-ink">😥 사진을 불러오지 못했어요. 다시 시도해 주세요.</p>
          ) : !ready ? (
            <p className="t-caption">사진을 불러오는 중이에요…</p>
          ) : (
            // 좌표 프레임 — 캔버스가 크기를 정하고(inline-block로 shrink-wrap), 오버레이는
            // absolute inset-0로 캔버스에 정확히 겹친다. overflow는 두지 않는다(손잡이가
            // 가장자리에서 잘리지 않게). touch-action:none으로 페이지 스크롤을 막는다.
            <div
              className="relative inline-block"
              style={{ touchAction: "none" }}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
            >
              <canvas
                ref={canvasRef}
                className="block rounded-[var(--radius-box)] border border-line"
                style={{ width: w, height: h }}
                aria-label="자를 영역을 손잡이로 조절하는 미리보기"
              />

              {showOverlay && sel && (
                <>
                  {/* 딤 레이어 — 선택 밖을 어둡게. 둥근 모서리로 클립, pointer 통과. */}
                  <div
                    className="pointer-events-none absolute inset-0 overflow-hidden rounded-[var(--radius-box)]"
                    aria-hidden
                  >
                    <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: sel.y, background: MASK }} />
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        top: sel.y + sel.height,
                        width: "100%",
                        height: Math.max(0, h - (sel.y + sel.height)),
                        background: MASK,
                      }}
                    />
                    <div style={{ position: "absolute", left: 0, top: sel.y, width: sel.x, height: sel.height, background: MASK }} />
                    <div
                      style={{
                        position: "absolute",
                        left: sel.x + sel.width,
                        top: sel.y,
                        width: Math.max(0, w - (sel.x + sel.width)),
                        height: sel.height,
                        background: MASK,
                      }}
                    />
                    {/* 선택 테두리 */}
                    <div
                      style={{
                        position: "absolute",
                        left: sel.x,
                        top: sel.y,
                        width: sel.width,
                        height: sel.height,
                        boxSizing: "border-box",
                        border: "2px solid #fff",
                        boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
                      }}
                    />
                  </div>

                  {/* 조작 레이어 — 손잡이가 가장자리에서 잘리지 않게 클립하지 않는다. */}
                  <div className="absolute inset-0">
                    {/* 박스 안쪽 = 이동면 (손잡이보다 아래에 둔다) */}
                    <div
                      onPointerDown={(e) => startDrag(e, "move")}
                      style={{
                        position: "absolute",
                        left: sel.x,
                        top: sel.y,
                        width: sel.width,
                        height: sel.height,
                        cursor: "move",
                        touchAction: "none",
                      }}
                      aria-hidden
                    />
                    {HANDLES.map((hd) => {
                      const cx = hd.cx(sel);
                      const cy = hd.cy(sel);
                      return (
                        <div
                          key={hd.id}
                          onPointerDown={(e) => startDrag(e, hd.id)}
                          style={{
                            position: "absolute",
                            left: cx - HIT / 2,
                            top: cy - HIT / 2,
                            width: HIT,
                            height: HIT,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: hd.cursor,
                            touchAction: "none",
                          }}
                          aria-hidden
                        >
                          <span
                            style={{
                              width: DOT,
                              height: DOT,
                              background: "#fff",
                              border: "1px solid rgba(0,0,0,0.45)",
                              borderRadius: 4,
                              boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/*
         * 하단 버튼 — 좁은 폰 폭에서 emoji+한글이 한 줄에 안 들어가 깨지지 않게, 한 줄에 3개를
         * 밀어 넣지 않는다. 이미지 조정(회전)·주요 확인(이 영역만)은 각각 전체폭, 대안 2개(전체
         * 사용·취소)만 나란히. 모든 버튼은 `whitespace-nowrap`으로 글자가 줄바꿈되지 않게 한다.
         */}
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            className="u-btn u-btn-secondary whitespace-nowrap"
            disabled={cropping}
            onClick={() => setRotation((r) => (r + 90) % 360)}
            aria-label="사진 90도 회전"
          >
            ↻ 90° 회전
          </button>
          <button
            type="button"
            className="u-btn u-btn-primary whitespace-nowrap"
            disabled={!ready || !isCroppable(sel) || cropping}
            onClick={() => void handleCrop()}
          >
            {cropping ? "자르는 중이에요…" : "✂️ 이 영역만 남기기"}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="u-btn u-btn-secondary flex-1 whitespace-nowrap"
              disabled={cropping}
              onClick={() => onDone(workingFile)}
            >
              🖼️ 전체 사용
            </button>
            <button
              type="button"
              className="u-btn u-btn-secondary flex-1 whitespace-nowrap"
              disabled={cropping}
              onClick={onCancel}
            >
              취소
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

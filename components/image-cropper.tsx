"use client";

/**
 * components/image-cropper.tsx — 사진 자르기 모달 (클라이언트 전용, 공유 컴포넌트)
 *
 * 영어 표지·수학 문제집·영어 단어장 세 화면이 **같은 이 모달**을 쓴다. 파일 하나를 받아
 * 캔버스에 축소해 그리고, pointer 드래그로 사각형 1개를 골라 잘라낸 `File`을 돌려준다.
 * 좌표 변환·자르기는 `lib/image-crop.ts`의 순수 함수에 있고, 이 파일은 그 함수를 캔버스·
 * pointer 이벤트에 배선한다. 라이브러리 0(브라우저 canvas·pointer만).
 *
 * 자르기 목적: 배경·손가락·옆 페이지를 잘라내 판독 정확도를 높인다. 그래서 자유 사각형 1개면
 * 충분하다(회전·비율 고정 없음). 드래그를 못 하는 경우에도 "전체 사용"이 항상 있으므로
 * 기능이 막히지 않는다 — 그 위에 `role="dialog"`·ESC·포커스 트랩 정도만 얹는다.
 *
 * `lib/ai/*`는 import하지 않는다(번들 오염). 새 CSS 파일 없이 `u-*`·`t-*` 토큰과 Tailwind
 * 유틸만 쓰고, 캔버스·스크림 오버레이만 인라인 스타일을 최소로 쓴다. 보호자 호칭은 "엄빠".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadImage } from "@/lib/image-resize";
import { clampRect, cropImageFile, toSourceRect, type CropRect, type Size } from "@/lib/image-crop";

interface Props {
  file: File;
  /** 잘린 파일. "전체 사용"이면 원본 그대로 돌려준다. */
  onDone: (result: File) => void;
  onCancel: () => void;
}

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

/** 선택이 자를 만큼 큰가 — 너무 작은 드래그는 탭으로 보고 자르기를 막는다. */
function isCroppable(sel: CropRect | null): boolean {
  return sel != null && sel.width >= 8 && sel.height >= 8;
}

export default function ImageCropper({ file, onDone, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const [nat, setNat] = useState<Size | null>(null);
  const [displaySize, setDisplaySize] = useState<Size | null>(null);
  const [sel, setSel] = useState<CropRect | null>(null); // 표시 캔버스 좌표
  const [dragging, setDragging] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // 1) 이미지 로딩 (loadImage 재사용) — 원본 픽셀 크기를 잡는다.
  useEffect(() => {
    let cancelled = false;
    loadImage(file)
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
  }, [file]);

  // 2) 표시 크기 계산 — 로딩 후 + 화면 회전/리사이즈마다.
  useEffect(() => {
    if (!nat) return;
    const compute = () => {
      setDisplaySize(fitDisplay(nat));
      setSel(null); // 크기가 바뀌면 이전 선택 좌표가 무의미하다 — 리셋
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [nat]);

  // 3) 캔버스에 이미지 + 선택 오버레이 그리기.
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

    if (sel && sel.width > 0 && sel.height > 0) {
      // 선택 밖을 어둡게 — 네 밴드로 덮는다(선택 영역은 그대로 밝게 남는다).
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, w, sel.y); // 위
      ctx.fillRect(0, sel.y + sel.height, w, h - (sel.y + sel.height)); // 아래
      ctx.fillRect(0, sel.y, sel.x, sel.height); // 왼쪽
      ctx.fillRect(sel.x + sel.width, sel.y, w - (sel.x + sel.width), sel.height); // 오른쪽
      // 테두리
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(sel.x + 1, sel.y + 1, Math.max(0, sel.width - 2), Math.max(0, sel.height - 2));
    }
  }, [displaySize, sel]);

  useEffect(() => {
    draw();
  }, [draw]);

  // 4) pointer 드래그 → 선택 사각형(표시 좌표).
  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!displaySize || cropping) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointFromEvent(e);
    dragStartRef.current = p;
    setDragging(true);
    setSel({ x: p.x, y: p.y, width: 0, height: 0 });
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragging || !displaySize) return;
    const start = dragStartRef.current;
    if (!start) return;
    const p = pointFromEvent(e);
    // 시작점↔현재점을 정규화(위/왼쪽으로 드래그해도 폭·높이 ≥ 0), 표시 경계로 클램프.
    const raw: CropRect = {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      width: Math.abs(p.x - start.x),
      height: Math.abs(p.y - start.y),
    };
    setSel(clampRect(raw, displaySize));
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
    dragStartRef.current = null;
    // 너무 작은 드래그(탭)는 선택 없음으로 되돌린다 — 실수로 1px 자르기를 막는다.
    setSel((prev) => (isCroppable(prev) ? prev : null));
  }

  // 5) 자르기 실행.
  async function handleCrop() {
    if (!displaySize || !nat || !isCroppable(sel) || !sel) return;
    setCropping(true);
    try {
      const sourceRect = toSourceRect(sel, displaySize, nat);
      const result = await cropImageFile(file, sourceRect);
      onDone(result);
    } catch {
      setCropping(false);
      setLoadError(true);
    }
  }

  // 6) ESC 취소 + 포커스 트랩 + 바디 스크롤 잠금.
  useEffect(() => {
    const prevActive = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
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
      document.body.style.overflow = prevOverflow;
      prevActive?.focus?.();
    };
  }, [onCancel]);

  const ready = !!displaySize && !loadError;

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
          손가락으로 드래그해서 남길 부분을 감싸 주세요. 배경·손가락·옆 페이지를 잘라내면 더 잘
          읽혀요. 자르기 어려우면 <strong>전체 사용</strong>을 눌러도 돼요.
        </p>

        <div className="mt-4 flex items-center justify-center">
          {loadError ? (
            <p className="t-question-ko text-ink">😥 사진을 불러오지 못했어요. 다시 시도해 주세요.</p>
          ) : !ready ? (
            <p className="t-caption">사진을 불러오는 중이에요…</p>
          ) : (
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="max-w-full rounded-[var(--radius-box)] border border-line"
              style={{ touchAction: "none", cursor: "crosshair" }}
              aria-label="자를 영역을 드래그로 선택하는 미리보기"
            />
          )}
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="u-btn u-btn-primary flex-1"
            disabled={!ready || !isCroppable(sel) || cropping}
            onClick={() => void handleCrop()}
          >
            {cropping ? "자르는 중이에요…" : "✂️ 이대로 자르기"}
          </button>
          <button
            type="button"
            className="u-btn u-btn-secondary flex-1"
            disabled={cropping}
            onClick={() => onDone(file)}
          >
            🖼️ 전체 사용
          </button>
          <button
            type="button"
            className="u-btn u-btn-secondary"
            disabled={cropping}
            onClick={onCancel}
          >
            취소
          </button>
        </div>
      </div>
    </div>
  );
}

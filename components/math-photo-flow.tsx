"use client";

/**
 * 문제집 사진 판독 → 문제 고르기 → 3막 설명 (M3) — `/math/photo` 화면의 본체.
 *
 * 흐름: 사진 1장 고르기 → 클라이언트에서 리사이즈 → `POST /api/math/extract`(호출 A) →
 * 판독 확인 화면(수정 가능) → **고른 문제만** `POST /api/math/explain`을 한 건씩 →
 * 같은 화면에서 결과를 이어 붙인다.
 *
 * ── 이 화면이 존재하는 이유 ────────────────────────────────────────────────
 * 소마 사고력수학은 도형·규칙 찾기가 많아 **그림은 타이핑으로 전달할 수단이 아예 없다.**
 * 사진이 유일한 입력 경로다. 그래서 여기서 막히면 앱 자체가 쓰이지 않는다.
 *
 * ── 비용 안전장치 (docs/harness/math.md §8) ────────────────────────────────
 * 문제 1개 = 호출 B + C(재시도 시 ×2) ≈ 2~4회이고, 2단 그림까지 나가면 한 번 더다.
 * Math Master는 **페이지당 문제가 12개**라 전부 만들면 최대 48회 — 감당이 안 된다.
 * 그래서:
 *   1. 판독은 문제를 **읽기만** 한다. 설명은 사용자가 고른 문제에만 만든다.
 *   2. `gradedMark`가 있는 문제(= 엄빠가 이미 틀렸다고 표시한 문제)를 **기본 선택**으로 올린다.
 *   3. 한 번에 `MAX_EXPLAIN_SELECTION`개까지만 보낸다.
 *   4. **페이지 전체를 자동 처리하는 경로를 만들지 않는다** — "전부 만들기" 버튼이 없는 것이 사양이다.
 *
 * ── 사진은 설명 요청에도 함께 간다 [M6 §12] ────────────────────────────────
 * 판독에 쓴 사진(`lastDataUrl`)을 **그대로** `/api/math/explain`에도 실어 보낸다. 그래야
 * 호출 B·C가 도형을 직접 본다(§12-2) — `figureDesc` 한 줄로는 점판·보조선·색칠된 영역이
 * 옮겨지지 않아 그림 문제가 통째로 샜다. **크롭하지 않는다**(§12-3): 좌표가 어긋나면
 * 도형이 잘린다. 어느 문제인지는 `number` 필드가 말로 지목한다.
 * 대가는 요청 크기다 — 문제 3개를 고르면 같은 사진이 3번 나간다(순차 호출, §8 상한이 3).
 *
 * ── 사진은 저장하지 않는다 ─────────────────────────────────────────────────
 * 버킷도 서명 URL도 새 환경 변수도 없다. 영어 표지 판독과 같이 base64 data URL로 보내고,
 * 라우트는 프롬프트에만 쓰고 버린다(§11-2·§12-4 — 기록에 남는 것은 판독된 텍스트다).
 * 미리보기용 object URL은 화면에서 벗어날 때 해제한다.
 *
 * ── 디자인 ─────────────────────────────────────────────────────────────────
 * 새 CSS 없음 — `app/globals.css`의 `u-*`·`t-*`와 거기서 생성된 Tailwind 유틸만.
 * 위계는 색이 아니라 글자 크기로(DESIGN §4). 파랑(accent)은 강조 두셋에만 —
 * 채점 표시 배지 / 고른 문제 / 주요 버튼.
 *
 * `lib/ai/*`는 **타입만** import하는 것이 이 저장소의 규약이다. 예외가 하나 있다:
 * `isMarkedProblem()`은 §2-4의 기본 선택 판정을 담은 **단일 판정처**라 값으로 가져온다.
 * 여기에 `gradedMark !== "none"`을 다시 적으면 판정이 두 벌이 되고, 판정이 갈리는 순간
 * "왜 이 문제는 기본 선택이 아니지?"가 조용히 생긴다. (그 모듈은 zod와 순수 상수만
 * 의존한다 — openai·API 키를 건드리지 않아 번들에 새는 것이 없다.)
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { isMarkedProblem } from "@/lib/ai/math/schemas";
import type {
  ExtractedProblem,
  MathExtractResponse,
  WorksheetExtraction,
} from "@/lib/math-extract-contract";
import {
  MATH_EXPLAIN_LIMITS,
  type MathExplainErrorCode,
  type MathExplainRequest,
  type MathExplainResponse,
  type MathExplainSuccess,
} from "@/lib/math-explain-contract";
import { JPEG_QUALITY, MAX_IMAGE_EDGE } from "@/lib/upload-limits";
import MathExplanationView from "./math-explanation-view";

// ---------------------------------------------------------------------------
// 상한
// ---------------------------------------------------------------------------

/**
 * 한 번에 설명을 만들 수 있는 문제 수 (§8 비용 안전장치).
 *
 * **3인 근거:** 문제 1개가 호출 B + C = 2회, 답이 어긋나 재시도하면 4회, 2단 그림(호출 E)까지
 * 나가면 최대 5회다. 3문제면 최악 15회로, 영어 북카드 한 권을 만드는 흐름(표지 판독 + 본문
 * 배치 + 카드 = 10회 안팎)과 같은 자릿수에 머문다. 시간으로도 한 문제가 30초쯤이라 3문제면
 * 1분 30초 — 아이를 옆에 앉혀 두고 기다릴 수 있는 상한이 이쯤이다.
 *
 * 더 필요하면 만들고 나서 목록으로 돌아와 다시 고르면 된다. 한 번에 여는 문을 좁게 두는 것이
 * 요점이다 — 12문제짜리 페이지에서 "전부"를 한 번에 누를 수 있으면 언젠가 눌린다.
 *
 * 정의처가 여기 하나인 이유: 이 숫자를 쓰는 곳이 이 화면뿐이다. `/api/math/explain`은 요청
 * 하나에 문제 하나를 받으므로 라우트 쪽에 같은 숫자가 필요하지 않다.
 */
const MAX_EXPLAIN_SELECTION = 3;

/**
 * 입력 길이 상한은 **여기서 정하지 않는다** — `MATH_EXPLAIN_LIMITS`가 라우트 zod와
 * 공유하는 단일 정의처다(`lib/math-explain-contract.ts`). 이 화면에서 두 번 쓴다:
 *   ① 입력창 `maxLength` — 고치는 중에 상한을 넘기지 못하게
 *   ② `overLongNotes()` — **보내기 전에** 넘치는 판독본을 짚어 준다
 *
 * ②가 필요한 이유(QA F3): 판독(호출 A)에는 문장 길이 상한이 **없다**. 서술형 하나가
 * 길거나 두세 문제가 한 덩어리로 읽히면 2,000자를 넘긴 채로 확인 화면에 올라오는데,
 * `maxLength`는 **이미 들어 있는 긴 값을 자르지 않는다.** 그대로 보내면 라우트가 400을
 * 내고 화면에는 "입력 내용을 확인해 주세요"만 떠서 원인 불명의 실패가 된다.
 */
const LIMITS = MATH_EXPLAIN_LIMITS;

/** 1,234 — 자릿수가 큰 글자 수는 쉼표가 있어야 한눈에 읽힌다 */
function fmtCount(n: number): string {
  return n.toLocaleString("ko-KR");
}

/**
 * 보내기 전에 재는 길이. 비어 있으면 보낼 수 있고, 한 줄이라도 있으면 그 문제는 고를 수 없다.
 *
 * 재는 값은 `explainOne()`이 **실제로 보내는 값**(trim한 문자열)이고, 라우트 zod도
 * `.trim().max()` 순서라 같은 길이를 잰다 — 화면과 라우트의 판정이 갈리지 않는다.
 *
 * 여기서 보는 것은 사용자가 **고칠 수 있는** 두 필드뿐이다. `childWork`·`givens`처럼
 * 편집 폼이 없는 필드까지 막으면 사용자에게 빠져나갈 길이 없어진다 — 그쪽은 400의
 * `issues`를 결과 화면에 그대로 보여 주는 것으로 받는다(같은 F3의 다른 갈래).
 */
function overLongNotes(d: Draft): string[] {
  const notes: string[] = [];
  const check = (label: string, value: string, max: number) => {
    const len = value.trim().length;
    if (len > max) {
      notes.push(
        `${label}이 ${fmtCount(len)}자예요 — ${fmtCount(max)}자까지 보낼 수 있어요. ${fmtCount(len - max)}자만 줄여 주세요.`,
      );
    }
  };
  check("문제 문장", d.text, LIMITS.text);
  check("그림·표 설명", d.figureDesc ?? "", LIMITS.figureDesc);
  return notes;
}

// ---------------------------------------------------------------------------
// 사진 리사이즈 (canvas — 긴 변 MAX_IMAGE_EDGE, JPEG)
//   `components/home-create.tsx`와 같은 방식이다. 상한은 `lib/upload-limits.ts`가 단일 정의처.
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
// 화면 상태
// ---------------------------------------------------------------------------

type Phase = "pick" | "reading" | "review" | "explaining" | "done";

/**
 * 확인 화면에서 사용자가 고칠 수 있는 판독본 (§2-4 2번 — **수정본이 호출 B의 입력이 된다**).
 * 원본 문장(`origText`)을 함께 붙들어 두는 이유는 "잘렸다"는 경고를 언제 거둘지 판정하기
 * 위해서다 — 사용자가 문장을 손대면 잘린 채로 설명이 만들어질 위험이 사라진다.
 */
interface Draft extends ExtractedProblem {
  origText: string;
}

/** 문제 1개에 대한 설명 생성 결과 */
interface Outcome {
  key: number;
  draft: Draft;
  result: MathExplainSuccess | null;
  errorKo: string | null;
  /**
   * 라우트가 준 오류 코드. 화면이 **행동을 가르는 데** 쓴다 —
   * `invalid_input`은 같은 입력으로 다시 눌러도 같은 400이라 '다시 만들기' 대신 '고치기'를 준다.
   */
  code: MathExplainErrorCode | null;
  /**
   * 400의 `issues[].message` — 라우트 zod가 한국어로 적어 둔 거절 사유.
   * 이것을 버리면 사용자는 "입력 내용을 확인해 주세요"만 보고 무엇을 확인할지 모른다(QA F3).
   */
  issues: string[];
}

/** 채점 표시 배지 문구 (§2-1 4번 — 뜻은 판단하지 않고 '표시가 있다'만 말한다) */
const MARK_BADGE: Record<ExtractedProblem["gradedMark"], string | null> = {
  circled: "⭕ 동그라미 표시",
  checked: "✔️ 체크 표시",
  none: null,
};

/**
 * 글자 수 표시 — **넘쳤거나 코앞일 때만** 뜬다.
 *
 * 늘 띄우면 평소(몇십 자짜리 초등 문제)에는 아무 뜻 없는 숫자가 화면마다 붙는다.
 * 정작 필요한 것은 판독이 상한을 넘겨 왔을 때 "얼마나 줄여야 하는가" 하나다.
 */
function CharCount({ value, max }: { value: string; max: number }) {
  const len = value.trim().length;
  if (len <= max * 0.9) return null;
  return (
    <p className="t-caption mt-1">
      {len > max ? "📏 " : ""}
      {fmtCount(len)} / {fmtCount(max)}자
      {len > max ? ` — ${fmtCount(len - max)}자 줄여 주세요` : ""}
    </p>
  );
}

export default function MathPhotoFlow() {
  const [phase, setPhase] = useState<Phase>("pick");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openEditor, setOpenEditor] = useState<Set<number>>(new Set());

  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /** 결과 화면에서 다시 만드는 중인 문제의 key — 한 번에 하나만 (비용을 눈으로 따라갈 수 있게) */
  const [retryingKey, setRetryingKey] = useState<number | null>(null);

  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [canRetry, setCanRetry] = useState(false);
  /** §2-4 폴백 — "문제집이 아니에요/못 읽었어요". 오류 배너와 문구·행동이 다르다 */
  const [retakeKo, setRetakeKo] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  /** 마지막으로 보낸 사진 — "다시 읽기"가 사진을 또 고르게 만들지 않도록 붙들어 둔다 */
  const lastDataUrl = useRef<string | null>(null);
  /** 설명 만들기 중단 신호 — 다음 문제로 넘어가기 전에 확인한다(이미 나간 호출은 못 되돌린다) */
  const stopRef = useRef(false);
  /**
   * 배치 실행 재진입 가드 (§8 비용 축, QA F1).
   *
   * 버튼의 `disabled={running…}`는 **리렌더 뒤에야** 걸린다. 같은 동기 tick 안에 `click`이
   * 두 번 들어오면 React가 아직 `phase`를 바꾸지 않아 두 실행이 나란히 시작하고, 호출이
   * 그대로 두 배가 된다(3문제 × 2벌 = 최대 30회). 상태가 아니라 ref라야 그 tick 안에서 막힌다.
   */
  const runningRef = useRef(false);
  /** 결과 화면 '다시 만들기'의 같은 가드 — `retryingKey` 상태도 같은 tick에서는 늦다 */
  const retryingRef = useRef(false);

  const busy = phase === "reading" || phase === "explaining";

  // 경과 시간 — 판독 10초, 설명 30초쯤. 숫자가 올라가는 것만 보여도 "멈췄나?"가 크게 준다
  useEffect(() => {
    if (!busy) return;
    setElapsedSec(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsedSec(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // 미리보기 object URL 해제 — 화면을 떠나거나 사진을 바꿀 때
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function clearStatus() {
    setErrorKo(null);
    setIssues([]);
    setCanRetry(false);
    setRetakeKo(null);
  }

  // -------------------------------------------------------------------------
  // 1) 사진 → 판독 (호출 A)
  // -------------------------------------------------------------------------

  async function readPhoto(dataUrl: string) {
    lastDataUrl.current = dataUrl;
    setPhase("reading");
    clearStatus();

    try {
      const res = await fetch("/api/math/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      const data = (await res.json().catch(() => null)) as MathExtractResponse | null;

      if (data?.ok) {
        applyExtraction(data.extraction);
        return;
      }

      // §2-4 폴백 — 오류가 아니다. 다시 찍기 + 직접 입력으로 안내한다
      if (data && "reason" in data) {
        setSource(data.extraction.source);
        setRetakeKo(data.messageKo);
        setPhase("pick");
        return;
      }

      setErrorKo(data?.messageKo ?? "사진을 읽지 못했어요. 잠시 후 다시 시도해 주세요.");
      setCanRetry(data?.retriable === true || res.status >= 500);
      setIssues(data && "issues" in data ? (data.issues ?? []).map((i) => i.message) : []);
      setPhase("pick");
    } catch {
      setErrorKo("인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
      setCanRetry(true);
      setPhase("pick");
    }
  }

  /**
   * 판독본을 확인 화면 상태로 옮긴다. **순서는 사진에 찍힌 그대로 둔다** —
   * 채점 표시가 있는 문제를 위로 끌어올리면 부모가 종이와 대조할 수 없게 된다.
   * §2-4가 말하는 "먼저"는 **기본 선택**과 배지로 세우고, 순서는 건드리지 않는다.
   */
  function applyExtraction(extraction: WorksheetExtraction) {
    const next: Draft[] = extraction.problems.map((p) => ({ ...p, origText: p.text }));
    setSource(extraction.source);
    setDrafts(next);
    setOutcomes([]);
    // §2-4 3번 — 채점 표시가 있는 문제를 기본 선택으로. 상한을 넘으면 앞에서부터 상한까지만.
    // 길이가 넘치는 문제는 기본 선택에서 뺀다 — 미리 골라 두면 사용자가 손대지도 않은 채
    // 400을 맞는다. 카드의 📏 안내가 "줄이면 고를 수 있어요"로 데려간다(QA F3).
    setSelected(
      new Set(
        next
          .map((p, i) => (isMarkedProblem(p) && overLongNotes(p).length === 0 ? i : -1))
          .filter((i) => i >= 0)
          .slice(0, MAX_EXPLAIN_SELECTION),
      ),
    );
    setOpenEditor(new Set());
    setPhase("review");
  }

  async function onPickFile(file: File) {
    clearStatus();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setPhase("reading");
    try {
      const dataUrl = await resizeToJpegDataUrl(file);
      await readPhoto(dataUrl);
    } catch {
      setErrorKo("사진을 불러오지 못했어요. 다른 사진으로 다시 시도해 주세요.");
      setPhase("pick");
    }
  }

  // -------------------------------------------------------------------------
  // 2) 고른 문제 → 설명 (호출 B, 한 건씩)
  // -------------------------------------------------------------------------

  async function explainSelected() {
    // 같은 tick 이중 클릭 차단 — `runningRef` 주석 참조. 상태를 건드리기 **전에** 나간다.
    if (runningRef.current) return;

    const picks = [...selected]
      .sort((a, b) => a - b)
      // 길이 초과는 고르는 단계에서 이미 막지만, 상한 3과 같이 2겹으로 둔다 —
      // 라우트가 400으로 되돌려 보낼 것을 보낼 이유가 없다.
      .filter((idx) => overLongNotes(drafts[idx]).length === 0)
      .slice(0, MAX_EXPLAIN_SELECTION);
    if (picks.length === 0) return;

    runningRef.current = true;
    stopRef.current = false;
    clearStatus();
    setOutcomes([]);
    setProgress({ done: 0, total: picks.length });
    setPhase("explaining");

    const collected: Outcome[] = [];

    try {
      // **한 건씩 순서대로.** 동시에 쏘면 중단 버튼이 무의미해지고, 실패해도 어느 문제에서
      // 났는지 화면이 못 짚는다. 비용을 눈으로 따라갈 수 있는 것이 여기서는 속도보다 중요하다.
      for (const idx of picks) {
        if (stopRef.current) break;
        const draft = drafts[idx];
        const outcome = await explainOne(idx, draft);
        collected.push(outcome);
        setOutcomes([...collected]);
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      setPhase("done");
    } finally {
      // 중간에 던져도 가드는 반드시 풀린다 — 안 풀리면 버튼이 영영 죽는다
      runningRef.current = false;
    }
  }

  async function explainOne(key: number, draft: Draft): Promise<Outcome> {
    const body: MathExplainRequest = {
      text: draft.text.trim(),
      number: draft.number,
      figureDesc: draft.figureDesc?.trim() || null,
      // 판독된 숫자는 그대로 넘긴다 — 문장을 고쳐도 여기 담긴 값은 사진에서 읽은 것이라 유효하다
      givens: draft.givens.length > 0 ? draft.givens : null,
      childAnswer: draft.childAnswer?.trim() || null,
      childWork: draft.childWork?.trim() || null,
      /**
       * [M6 §12-3] **판독에 쓴 사진 그대로** — 크롭하지 않은 페이지 전체다.
       *
       * 이 한 줄이 호출 B(설명 설계)와 호출 C(검산) 둘 다에게 그림을 보여 준다(§12-2).
       * 도형·점판·보조선·색칠된 영역은 `figureDesc` 한 줄로 옮겨지지 않아서, 이것이
       * 없으면 그림 문제는 통째로 샌다(2026-08-21 "그림을 이해하지 못한다" 보고).
       *
       * **잘라 보내지 마라.** 문제 영역만 크롭하면 토큰은 싸지지만 좌표가 조금만
       * 어긋나도 도형의 일부가 잘려 나간다 — 그림이 필요해서 넣은 기능이 그림을
       * 훼손하는 실패 모드다. 어느 문제인지는 `number` 필드가 말로 지목한다.
       *
       * 타입은 `string | null`이지만 이 화면에서는 사실상 항상 있다 — 판독(`readPhoto`)이
       * 성공해야 확인 화면이 열리고, 그 함수가 맨 먼저 `lastDataUrl`을 채운다.
       * `null`이어도 요청은 그대로 나간다(사진만 빠지고 텍스트로 돈다, §12-4) —
       * 사진 하나 때문에 설명을 못 만들게 되는 편이 더 나쁘다.
       */
      imageDataUrl: lastDataUrl.current,
    };

    try {
      const res = await fetch("/api/math/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as MathExplainResponse | null;
      if (data?.ok) return { key, draft, result: data, errorKo: null, code: null, issues: [] };
      // 라우트 zod가 한국어로 적어 둔 거절 사유를 그대로 올린다. 여기서 버리면 사용자는
      // "입력 내용을 확인해 주세요"만 보고 무엇을 확인해야 하는지 알 수 없다(QA F3).
      // M1 폼(`math-explain-form.tsx`)이 이미 같은 규약을 쓴다 — 두 화면이 같게 말한다.
      return {
        key,
        draft,
        result: null,
        errorKo: data?.messageKo ?? "설명을 만들지 못했어요.",
        code: data && !data.ok ? data.error : null,
        issues: data && !data.ok ? (data.issues ?? []).map((i) => i.message) : [],
      };
    } catch {
      return {
        key,
        draft,
        result: null,
        errorKo: "인터넷 연결이 끊겨 설명을 만들지 못했어요.",
        code: null,
        issues: [],
      };
    }
  }

  /**
   * 실패한 문제 하나만 다시 만든다 (결과 화면). 성공한 설명은 그대로 둔다.
   * 가드가 `retryingKey` 상태가 아니라 ref인 이유는 `explainSelected()`와 같다 —
   * 상태는 리렌더 뒤에야 보여서 같은 tick의 두 번째 클릭을 못 막는다(QA F1).
   */
  async function retryOne(key: number) {
    if (retryingRef.current) return;
    const target = outcomes.find((o) => o.key === key);
    if (!target) return;
    retryingRef.current = true;
    setRetryingKey(key);
    try {
      const next = await explainOne(key, target.draft);
      setOutcomes((prev) => prev.map((o) => (o.key === key ? next : o)));
    } finally {
      retryingRef.current = false;
      setRetryingKey(null);
    }
  }

  // -------------------------------------------------------------------------
  // 상태 조작 헬퍼
  // -------------------------------------------------------------------------

  function toggleSelected(idx: number) {
    // 끄는 것은 언제나 되고, **켜는 것만** 막는다 — 상한(3)과 길이 초과 두 가지 이유로.
    // 체크박스 `disabled`는 이미 같은 판정을 하지만, 상한과 같이 상태 수준에서도 막는다.
    const blocked = overLongNotes(drafts[idx]).length > 0;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else if (!blocked && next.size < MAX_EXPLAIN_SELECTION) next.add(idx);
      return next;
    });
  }

  function toggleEditor(idx: number) {
    setOpenEditor((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function patchDraft(idx: number, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }

  function resetAll() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    lastDataUrl.current = null;
    setDrafts([]);
    setSelected(new Set());
    setOpenEditor(new Set());
    setOutcomes([]);
    setSource(null);
    clearStatus();
    setPhase("pick");
  }

  // 결과가 나오면 화면 맨 위로 — 긴 목록 아래에 설명이 붙으면 스크롤을 놓친다
  useEffect(() => {
    if (phase === "done") topRef.current?.scrollIntoView({ block: "start" });
  }, [phase]);

  // -------------------------------------------------------------------------
  // 공통 조각
  // -------------------------------------------------------------------------

  const hiddenInput = (
    /*
     * 파일 입력은 **항상 마운트**해 둔다. 버튼 핸들러가 같은 제스처 안에서 곧바로
     * `.click()`을 불러야 Safari가 파일 대화상자를 막지 않는다.
     * `capture`는 쓰지 않는다 — 모바일이 카메라를 바로 열어 버려 이미 찍어 둔 사진을
     * 고를 수 없게 된다(카메라는 그 선택 시트에서 여전히 갈 수 있다).
     */
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      className="hidden"
      tabIndex={-1}
      aria-hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = ""; // 같은 사진을 다시 골라도 change가 나게
        if (file) void onPickFile(file);
      }}
    />
  );

  const errorBanner = errorKo && (
    <div className="u-box mb-6 border border-line-strong" role="alert">
      <p className="t-question-ko text-ink">😥 {errorKo}</p>
      {issues.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {issues.map((issue, i) => (
            <li key={i} className="t-caption">
              · {issue}
            </li>
          ))}
        </ul>
      )}
      {canRetry && lastDataUrl.current && (
        <button
          type="button"
          className="u-btn u-btn-secondary mt-3"
          onClick={() => {
            const url = lastDataUrl.current;
            if (url) void readPhoto(url);
          }}
        >
          🔄 다시 읽기
        </button>
      )}
    </div>
  );

  // -------------------------------------------------------------------------
  // 결과 화면
  // -------------------------------------------------------------------------

  if (phase === "done") {
    const madeCount = outcomes.filter((o) => o.result).length;
    const leftover = drafts.length - outcomes.length;

    return (
      <div ref={topRef}>
        {/*
         * 하나도 못 만들었으면 축하 배너를 띄우지 않는다. "✅ 0개 준비됐어요"는
         * 화면이 자기가 실패한 줄 모른다는 뜻이라, 읽는 사람이 앱을 못 믿게 된다.
         */}
        <div className={`mb-6 ${madeCount > 0 ? "u-box-accent" : "u-box border border-line-strong"}`}>
          <p className="t-list-title">
            {madeCount > 0
              ? `✅ 문제 ${madeCount}개의 설명이 준비됐어요`
              : "😥 설명을 만들지 못했어요"}
          </p>
          {madeCount === 0 && (
            <p className="t-question-ko mt-1 text-ink">
              문제마다 있는 &lsquo;다시 만들기&rsquo;를 눌러 보시거나, 잠시 후 다시 시도해 주세요.
            </p>
          )}
          {leftover > 0 && (
            <p className="t-question-ko mt-1 text-ink">
              이 페이지에는 문제가 {drafts.length}개 있어요. 남은 {leftover}개는 목록으로
              돌아가서 이어서 고르면 돼요.
            </p>
          )}
        </div>

        {outcomes.length > 1 && (
          <nav className="mb-6 flex flex-wrap gap-2" aria-label="문제 바로가기">
            {outcomes.map((o) => (
              <a key={o.key} href={`#p-${o.key}`} className="u-chip">
                {o.draft.number ? `${o.draft.number}번` : `문제 ${o.key + 1}`}
              </a>
            ))}
          </nav>
        )}

        {outcomes.map((o) => (
          <section key={o.key} id={`p-${o.key}`} className="mb-12 scroll-mt-4">
            <p className="t-caption mb-2">
              📄 {source ?? "문제집"}
              {o.draft.number ? ` · ${o.draft.number}번` : ""}
            </p>
            {o.result ? (
              <>
                <MathExplanationView problemText={o.draft.text} result={o.result} />
                {/*
                 * [§9-3] 라우트가 설명을 자동 저장하고 그 기록의 주소를 `id`로 돌려준다.
                 * **`id`가 null이면 저장이 실패한 것이다**(best-effort라 화면은 죽지 않는다).
                 * 그래도 담담하게 알려야 한다 — 알리지 않으면 나중에 서재에서 찾다가
                 * 없는 것을 앱의 배신으로 읽는다. `/math/new`와 같은 문구를 쓴다.
                 */}
                {o.result.id ? (
                  <p className="t-caption mt-3">
                    ✅ 보관됐어요 →{" "}
                    <Link
                      href={`/math/problem/${o.result.id}`}
                      className="font-medium text-accent underline"
                    >
                      따로 보기
                    </Link>
                  </p>
                ) : (
                  <p className="t-caption mt-3">
                    🗒️ 이번 건은 보관하지 못했어요. 화면의 설명은 그대로예요 — 새로고침하면
                    사라지니, 필요하면 지금 보여 주세요.
                  </p>
                )}
              </>
            ) : (
              <div className="u-box border border-line-strong" role="alert">
                <p className="t-question-ko text-ink">😥 {o.errorKo}</p>
                {/*
                 * 라우트가 준 사유를 그대로 보여 준다. 이것이 없으면 길이 초과 같은 400은
                 * "입력 내용을 확인해 주세요"로만 보여 원인 불명의 실패가 된다(QA F3).
                 */}
                {o.issues.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1">
                    {o.issues.map((issue, i) => (
                      <li key={i} className="t-caption">
                        · {issue}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="t-caption mt-2">{o.draft.text}</p>
                {/*
                 * 실패한 문제만 다시 만든다. 목록으로 돌아가 다시 고르게 하면 성공한
                 * 설명까지 화면에서 사라지고, 무심코 셋을 통째로 다시 태우게 된다.
                 *
                 * 다만 입력이 거절된 것(400)은 **같은 입력으로 다시 눌러도 같은 400이다.**
                 * 그 자리에 '다시 만들기'를 두면 눌러도 아무 일이 안 일어나는 버튼이 된다 —
                 * 고칠 수 있는 곳(목록의 편집 폼)으로 데려간다.
                 */}
                {o.code === "invalid_input" ? (
                  <button
                    type="button"
                    className="u-btn u-btn-secondary mt-3"
                    onClick={() => {
                      setSelected(new Set());
                      setOpenEditor(new Set([o.key]));
                      setPhase("review");
                    }}
                  >
                    ✏️ 목록에서 이 문제 고치기
                  </button>
                ) : (
                  <button
                    type="button"
                    className="u-btn u-btn-secondary mt-3"
                    disabled={retryingKey !== null}
                    onClick={() => void retryOne(o.key)}
                  >
                    {retryingKey === o.key ? "다시 만드는 중이에요…" : "🔄 이 문제 다시 만들기"}
                  </button>
                )}
              </div>
            )}
          </section>
        ))}

        <div className="mt-10 flex flex-wrap gap-2">
          {drafts.length > 0 && (
            <button
              type="button"
              className="u-btn u-btn-primary"
              onClick={() => {
                setSelected(new Set());
                setPhase("review");
              }}
            >
              📋 문제 목록으로 돌아가기
            </button>
          )}
          <button type="button" className="u-btn u-btn-secondary" onClick={resetAll}>
            📷 다른 페이지 찍기
          </button>
          <Link href="/math" className="u-btn u-btn-secondary">
            🔢 수학 홈으로
          </Link>
        </div>
        <p className="t-caption mt-3">
          만든 설명은{" "}
          <Link href="/math/library" className="font-medium text-accent underline">
            지난 문제
          </Link>
          에 모여 있어요.
        </p>
        {hiddenInput}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // 판독 확인 화면 (목록 · 고르기 · 수정)
  // -------------------------------------------------------------------------

  if (phase === "review" || phase === "explaining") {
    const markedCount = drafts.filter((d) => isMarkedProblem(d)).length;
    const atCap = selected.size >= MAX_EXPLAIN_SELECTION;
    const running = phase === "explaining";
    /** 지금 상태로는 보낼 수 없는 문제 수 — 목록이 길면 카드까지 스크롤하기 전에 알아야 한다 */
    const overLongCount = drafts.filter((d) => overLongNotes(d).length > 0).length;

    return (
      <div ref={topRef}>
        {running && (
          <div className="u-box-accent mb-6" role="status" aria-live="polite">
            <p className="t-list-title">
              🧠 설명 만드는 중이에요 — {progress.done}/{progress.total}
            </p>
            <p className="t-question-ko mt-1 text-ink">
              설명을 만들고, 답이 맞는지 따로 한 번 더 풀어 봐요. 한 문제에 30초쯤 걸려요.
            </p>
            <p className="t-caption mt-2">{elapsedSec}초 지났어요</p>
            {/* 이미 나간 호출은 못 되돌리지만, 다음 문제로 넘어가는 것은 막을 수 있다 */}
            <button
              type="button"
              className="u-btn u-btn-secondary mt-3"
              onClick={() => {
                stopRef.current = true;
              }}
            >
              ✋ 남은 문제는 그만두기
            </button>
          </div>
        )}

        {errorBanner}

        <div className="mb-5 flex items-start gap-3">
          {previewUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- blob: 미리보기는 next/image가 다루지 않는다
            <img
              src={previewUrl}
              alt="방금 찍은 문제집 페이지"
              className="u-item-cover"
            />
          )}
          <div className="min-w-0">
            <p className="t-list-title">📄 문제 {drafts.length}개를 읽었어요</p>
            <p className="t-caption mt-1">
              {source ? `${source} · ` : ""}
              사진과 견주어 보고, 다르게 읽힌 곳은 고쳐 주세요. 고친 내용으로 설명을 만들어요.
            </p>
          </div>
        </div>

        <div className="u-box mb-5">
          <p className="t-question-ko text-ink">
            설명 만들 문제를 골라 주세요 —{" "}
            <b>
              {selected.size}/{MAX_EXPLAIN_SELECTION}
            </b>{" "}
            선택
          </p>
          <p className="t-caption mt-1">
            {/* 표시가 상한보다 많으면 "4개 골라 뒀어요"가 거짓말이 된다 — 세 문장을 갈라 둔다 */}
            {markedCount === 0
              ? "채점 표시가 보이지 않아, 미리 고른 문제가 없어요."
              : markedCount > MAX_EXPLAIN_SELECTION
                ? `채점 표시가 있는 문제가 ${markedCount}개예요 — 그중 앞의 ${MAX_EXPLAIN_SELECTION}개를 미리 골라 뒀어요.`
                : `채점 표시가 있는 문제 ${markedCount}개를 미리 골라 뒀어요.`}{" "}
            한 번에 {MAX_EXPLAIN_SELECTION}개까지 만들 수 있어요 — 한 문제를 만들 때마다 AI가
            두세 번 생각하거든요. 남은 문제는 만든 뒤에 이어서 고르면 돼요.
          </p>
          {/*
            [M6 §12] 사진이 설명 요청에도 함께 간다는 사실을 여기서 한 줄로 알린다.
            알릴 가치가 있는 이유는 **부모가 할 일이 달라지기 때문**이다:
              ① 도형·점판을 글로 받아쓰려던 손을 멈추게 한다(그림·표 설명 칸을 채우지 않아도 된다)
              ② "그림을 이해하지 못한다"고 느낀 사람에게 무엇이 달라졌는지 말해 준다
            "그림을 다 이해해요"라고는 말하지 않는다 — 지키지 못할 약속이고, 틀리면 다음에는
            아무 문구도 믿기지 않는다. 사진이 **함께 간다**는 사실만 적는다.
          */}
          {/* 🖼️는 바로 아래 문제 카드에서 이미 "그림·표 설명"을 가리킨다 — 같은 화면에서 두 뜻으로 쓰면 흐려진다 */}
          <p className="t-caption mt-2">
            👀 방금 그 사진도 함께 보고 설명을 만들어요 — 도형·표는 글로 옮겨 적지 않아도 괜찮아요.
          </p>
          {/* 카드까지 내려가기 전에 "왜 저건 못 고르지?"를 먼저 알려 준다 (QA F3) */}
          {overLongCount > 0 && (
            <p className="t-caption mt-2">
              📏 글이 너무 길어 지금은 고를 수 없는 문제가 {overLongCount}개 있어요 — 그 문제
              카드에서 &lsquo;✏️ 고치기&rsquo;로 줄여 주시면 고를 수 있어요.
            </p>
          )}
        </div>

        <ul className="flex flex-col gap-3">
          {drafts.map((d, idx) => {
            const checked = selected.has(idx);
            const badge = MARK_BADGE[d.gradedMark];
            const stillCut = d.truncated && d.text === d.origText;
            const tooLong = overLongNotes(d);
            const editing = openEditor.has(idx);
            return (
              <li
                key={idx}
                className={`rounded-[var(--radius-box)] border p-4 ${
                  checked ? "border-accent bg-accent-soft" : "border-line bg-bg"
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    id={`pick-${idx}`}
                    type="checkbox"
                    checked={checked}
                    disabled={running || tooLong.length > 0 || (!checked && atCap)}
                    onChange={() => toggleSelected(idx)}
                    className="mt-1 h-6 w-6 flex-none accent-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <label htmlFor={`pick-${idx}`} className="block cursor-pointer">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="t-list-title">
                          {d.number ? `${d.number}번` : `문제 ${idx + 1}`}
                        </span>
                        {badge && <span className="u-chip u-chip-accent">{badge}</span>}
                        {d.text !== d.origText && <span className="u-chip">✏️ 고쳤어요</span>}
                      </span>
                      <span className="t-body mt-2 block">{d.text}</span>
                    </label>

                    {d.figureDesc && (
                      <p className="t-question-ko mt-2">🖼️ {d.figureDesc}</p>
                    )}
                    {d.childAnswer && (
                      <p className="t-question-ko mt-1">✏️ 은우가 쓴 답: {d.childAnswer}</p>
                    )}

                    {/*
                     * 잘린 문장 경고 (§2-1 1번의 `truncated`). 그대로 설명을 만들면 문제의
                     * 절반만 보고 푸는 셈이라 엉뚱한 답이 나온다. 고칠 곳으로 바로 데려간다.
                     */}
                    {stillCut && (
                      <div className="u-box-accent mt-3">
                        <p className="t-question-ko text-ink">
                          ✂️ 이 문제는 문장이 잘려 보여요. 사진에서 잘린 부분을 채워 주세요 —
                          그대로 만들면 엉뚱한 답이 나와요.
                        </p>
                      </div>
                    )}

                    {/*
                     * 길이 초과 경고 (QA F3). 잘림 경고와 달리 **고르는 것 자체를 막는다** —
                     * 보내 봐야 라우트가 400으로 되돌려 보내고, 그 400은 화면에서 원인 불명의
                     * 실패로 보인다. 그래서 여기서 이유와 줄여야 할 글자 수를 미리 말한다.
                     */}
                    {tooLong.length > 0 && (
                      <div className="u-box mt-3 border border-line-strong">
                        <p className="t-question-ko text-ink">
                          📏 글이 너무 길어서 아직 고를 수 없어요. 아래 &lsquo;✏️ 고치기&rsquo;에서
                          줄여 주시면 바로 고를 수 있어요.
                        </p>
                        <ul className="mt-2 flex flex-col gap-1">
                          {tooLong.map((note, i) => (
                            <li key={i} className="t-caption">
                              · {note}
                            </li>
                          ))}
                        </ul>
                        <p className="t-caption mt-2">
                          한 문제가 이만큼 길면 대개 옆 문제까지 한 덩어리로 읽힌 거예요 — 이
                          문제에 해당하는 부분만 남겨 주세요.
                        </p>
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="u-navbtn"
                        disabled={running}
                        onClick={() => toggleEditor(idx)}
                        aria-expanded={editing}
                      >
                        {editing ? "접기" : "✏️ 고치기"}
                      </button>
                    </div>

                    {editing && (
                      <div className="mt-3 flex flex-col gap-4">
                        <div>
                          <label htmlFor={`text-${idx}`} className="u-label">
                            문제 문장
                          </label>
                          <textarea
                            id={`text-${idx}`}
                            rows={4}
                            maxLength={LIMITS.text}
                            disabled={running}
                            value={d.text}
                            onChange={(e) => patchDraft(idx, { text: e.target.value })}
                            className="u-input"
                          />
                          <CharCount value={d.text} max={LIMITS.text} />
                        </div>
                        <div>
                          <label htmlFor={`fig-${idx}`} className="u-label">
                            그림 · 표 설명
                          </label>
                          <textarea
                            id={`fig-${idx}`}
                            rows={2}
                            maxLength={LIMITS.figureDesc}
                            disabled={running}
                            value={d.figureDesc ?? ""}
                            onChange={(e) =>
                              patchDraft(idx, { figureDesc: e.target.value || null })
                            }
                            className="u-input"
                            placeholder="예: 통 가·나·다 그림, 아래는 각각 5L"
                          />
                          <CharCount value={d.figureDesc ?? ""} max={LIMITS.figureDesc} />
                        </div>
                        <div>
                          <label htmlFor={`child-${idx}`} className="u-label">
                            은우가 쓴 답
                          </label>
                          <input
                            id={`child-${idx}`}
                            maxLength={LIMITS.childAnswer}
                            disabled={running}
                            value={d.childAnswer ?? ""}
                            onChange={(e) =>
                              patchDraft(idx, { childAnswer: e.target.value || null })
                            }
                            className="u-input"
                            placeholder="비워 두면 채점 없이 설명만 만들어요"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {/* 주요 행동 — 목록 아래. 문제가 많으면 스크롤 끝에 있어야 손이 닿는다 */}
        <div className="mt-8 flex flex-col gap-3">
          <button
            type="button"
            disabled={running || selected.size === 0}
            onClick={() => void explainSelected()}
            className="u-btn u-btn-primary w-full"
          >
            {running
              ? "만드는 중이에요…"
              : `🪄 고른 ${selected.size}문제 설명 만들기`}
          </button>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="u-btn u-btn-secondary"
              disabled={running}
              onClick={() => fileInputRef.current?.click()}
            >
              📷 다시 찍기
            </button>
            <Link href="/math/new" className="u-btn u-btn-secondary">
              ✏️ 직접 입력하기
            </Link>
          </div>
        </div>
        {hiddenInput}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // 사진 고르기 / 판독 중
  // -------------------------------------------------------------------------

  return (
    <div ref={topRef}>
      {phase === "reading" && (
        <div className="u-box-accent mb-6" role="status" aria-live="polite">
          <p className="t-list-title">👀 사진을 읽고 있어요…</p>
          <p className="t-question-ko mt-1 text-ink">
            문제를 하나씩 나누고, 은우가 쓴 답과 채점 표시도 함께 찾는 중이에요.
          </p>
          <p className="t-caption mt-2">{elapsedSec}초 지났어요</p>
        </div>
      )}

      {errorBanner}

      {/* §2-4 폴백 — 오류가 아니라 "다시 찍어주세요"다. 문구도 행동도 다르게 둔다 */}
      {retakeKo && (
        <div className="u-box mb-6 border border-line-strong" role="status">
          <p className="t-list-title">📷 문제를 찾지 못했어요</p>
          <p className="t-question-ko mt-1 text-ink">{retakeKo}</p>
          <ul className="mt-3 flex flex-col gap-1">
            <li className="t-caption">· 페이지가 화면에 꽉 차게, 위에서 똑바로 찍어 주세요</li>
            <li className="t-caption">· 그림자와 손가락이 문제를 가리지 않게 해 주세요</li>
            <li className="t-caption">· 한 번에 한 페이지만 찍어 주세요</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="u-btn u-btn-primary"
              onClick={() => fileInputRef.current?.click()}
            >
              📷 다시 찍기
            </button>
            <Link href="/math/new" className="u-btn u-btn-secondary">
              ✏️ 직접 입력하기
            </Link>
          </div>
        </div>
      )}

      {previewUrl && phase === "reading" && (
        <div className="mb-6 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- blob: 미리보기는 next/image가 다루지 않는다 */}
          <img
            src={previewUrl}
            alt="방금 고른 문제집 사진"
            className="u-item-cover"
          />
          <p className="t-caption">이 사진을 읽는 중이에요</p>
        </div>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
        className="u-entry u-entry-primary"
      >
        <span className="u-entry-icon" aria-hidden>
          📷
        </span>
        <span className="u-entry-title">
          {busy ? "읽는 중이에요…" : "문제집 사진 고르기"}
        </span>
        <span className="u-entry-desc">
          한 번에 한 페이지씩. 찍어 둔 사진을 고르거나 지금 바로 찍어도 돼요.
        </span>
      </button>

      <section className="mt-8">
        <h2 className="t-section-title">이렇게 찍으면 잘 읽혀요</h2>
        <ul className="mt-3 flex flex-col gap-2">
          <li className="u-box t-question-ko">📐 페이지를 화면에 꽉 차게, 위에서 똑바로</li>
          <li className="u-box t-question-ko">💡 그림자 없이 밝은 곳에서</li>
          <li className="u-box t-question-ko">
            ✏️ 은우가 쓴 답과 빨간 채점 표시도 함께 읽어요 — 지우지 않고 찍어 주세요
          </li>
        </ul>
        {/*
          [M6 §12] "읽는 데만"은 이제 사실이 아니다 — 같은 사진이 설명을 만들 때도 함께 간다.
          쓰임이 늘었으니 문구도 늘린다. 안심의 근거는 "쓰임이 좁다"가 아니라 "남지 않는다"이고,
          그쪽은 그대로다(§9-1 — 기록에 남는 것은 판독된 텍스트뿐이다).
        */}
        <p className="t-caption mt-3">
          사진은 문제를 읽고 설명을 만드는 데에만 쓰고, 저장하지 않아요.
        </p>
      </section>

      <div className="mt-8">
        <Link href="/math/new" className="u-btn u-btn-secondary">
          <span aria-hidden>✏️</span> 문제를 직접 적을래요
        </Link>
      </div>
      {hiddenInput}
    </div>
  );
}

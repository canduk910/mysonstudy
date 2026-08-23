"use client";

/**
 * 단어장 사진 판독 → 검토 → 저장 (단어장 정복 V1) — `/english/vocab/new` 화면의 본체.
 *
 * 흐름: 사진 **여러 장**을 쌓아 고르기 → 클라이언트에서 각 장 리사이즈 →
 * `POST /api/english/vocab/extract`(호출 C, 병렬 판독 + 번호 병합) → 검토 화면(빼기·인라인
 * 편집·빠진 번호 안내·잘림 경고) → `POST /api/english/vocab`(저장) → 표 화면으로 이동.
 *
 * ── 수학 사진 흐름과 다른 점 (계획 §3-5) ───────────────────────────────────
 * 수학은 "고른 3문제만" 설명을 만든다(비용). 단어장은 **전부 저장이 기본이고 "빼기"가 성격**이다 —
 * 판독은 책 전사라 창작 비용이 없고, DAY 하나가 통째로 한 레코드다. 그래서 3개 상한·gradedMark·
 * 순차 루프를 버리고, 검토는 "이 단어는 빼기"를 고르는 화면이 된다.
 *
 * Phase 상태기계·재진입 가드(runningRef)·`CharCount`·미리보기 URL 해제는 `math-photo-flow.tsx`의
 * 관용구를 그대로 가져왔다. 여러 장 누적 업로드(capture 금지·덧붙이기)는 `home-create.tsx`에서.
 *
 * ── 사진은 저장하지 않는다 ─────────────────────────────────────────────────
 * base64 data URL로 판독에만 보내고 라우트는 프롬프트에만 쓰고 버린다(§7-6). 저장되는 것은
 * 병합된 단어 텍스트뿐이다. 미리보기용 object URL은 화면을 벗어나거나 사진을 바꿀 때 해제한다.
 *
 * ── 디자인 ─────────────────────────────────────────────────────────────────
 * 새 CSS 없음 — `app/globals.css`의 `u-*`·`t-*`와 거기서 생성된 Tailwind 유틸만. 위계는 색이
 * 아니라 글자 크기로(DESIGN §4). 보호자 호칭은 "엄빠".
 *
 * `lib/ai/*`는 **타입만** import한다(계약 모듈 경유). 예외: `PART_OF_SPEECH_LABELS_KO`·
 * `RELATED_KIND_LABELS_KO`는 라벨 상수(단일 정의처)라 값으로 가져온다 — 그 모듈은 zod만
 * 의존하고 openai·API 키를 건드리지 않아 번들에 새는 것이 없다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  PART_OF_SPEECH_LABELS_KO,
  RELATED_KIND_LABELS_KO,
} from "@/lib/ai/english/vocabbook-schemas";
import { resizeToJpegDataUrl } from "@/lib/image-resize";
import ImageCropper from "./image-cropper";
import { VOCAB_LIMITS, type VocabCreateResponse } from "@/lib/vocab-create-contract";
import type { VocabEntry, VocabExtractResponse } from "@/lib/vocab-extract-contract";

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------

type Phase = "pick" | "reading" | "review" | "saving";

// ---------------------------------------------------------------------------
// 진단용 계측 (카메라 사진 유실 버그 — 재현 후 제거 예정)
// ---------------------------------------------------------------------------
// 왜 sessionStorage: 모바일 카메라가 페이지를 재생성(리마운트)하면 React state는 날아가지만
// sessionStorage는 남아 **리마운트 자체를 증거로 포착**한다. 로그는 로직에 관여하지 않는다.
const DEBUG_LOG_KEY = "vocab-photo-debug";

/** 1,234 — 자릿수가 큰 글자 수는 쉼표가 있어야 한눈에 읽힌다 */
function fmtCount(n: number): string {
  return n.toLocaleString("ko-KR");
}

/**
 * 글자 수 표시 — **넘쳤거나 코앞일 때만** 뜬다 (math-photo-flow의 CharCount와 같은 관용구).
 * 평소(짧은 단어·뜻)에는 아무 뜻 없는 숫자를 화면에 붙이지 않는다.
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

/** 판독 결과의 부가 정보 — 검토 화면 상단 안내에 쓴다 */
interface ReviewMeta {
  dayLabel: string | null;
  mergedCount: number;
  missingNos: string[];
  photoCount: number;
  failedPhotoCount: number;
}

export default function VocabbookPhotoFlow() {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("pick");

  // 사진 누적 (판독 전) — 파일과 미리보기 URL을 나란히 든다
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  /** 자르기 모달에 올릴 사진의 인덱스. null이면 모달을 닫는다. (담긴 뒤 "다시 자르기") */
  const [cropIndex, setCropIndex] = useState<number | null>(null);
  /**
   * 자르기 대기 큐 — 새로 고른 사진들은 목록에 넣기 전에 여기 쌓여, 맨 앞부터 한 장씩
   * 자동으로 자르기 모달이 열린다. onDone이면 결과를 목록에 넣고, 취소면 그 장만 버린 뒤
   * 둘 다 큐를 한 칸 당긴다(다음 장 자동 오픈). 여러 장을 한 번에 골라도 순차로 자른다.
   */
  const [cropQueue, setCropQueue] = useState<File[]>([]);

  // 판독 결과 (검토 단계)
  const [entries, setEntries] = useState<VocabEntry[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Set<number>>(new Set());
  const [titleKo, setTitleKo] = useState("");
  const [meta, setMeta] = useState<ReviewMeta | null>(null);

  // 상태·오류
  const [errorKo, setErrorKo] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [canRetry, setCanRetry] = useState(false);
  const [retakeKo, setRetakeKo] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 판독·저장 재진입 가드 — 버튼 disabled는 리렌더 뒤에야 걸려, 같은 tick 이중 클릭을 못 막는다 */
  const runningRef = useRef(false);

  // 진단용 디버그 로그 state (버그 재현 후 제거 예정)
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [debugOpen, setDebugOpen] = useState(true);

  /**
   * 영속 로그 — `${시각} msg`를 sessionStorage 배열에 append + 화면 state에 반영.
   * sessionStorage를 진실 원천으로 삼아(리마운트에도 생존), 매 호출마다 새로 읽어 이어붙인다.
   */
  function dlog(msg: string) {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
    try {
      const prev = JSON.parse(sessionStorage.getItem(DEBUG_LOG_KEY) ?? "[]") as string[];
      const next = [...prev, line];
      sessionStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(next));
      setDebugLog(next);
    } catch {
      setDebugLog((p) => [...p, line]);
    }
  }

  function copyDebugLog() {
    navigator.clipboard?.writeText(debugLog.join("\n")).catch(() => {});
  }

  function clearDebugLog() {
    try {
      sessionStorage.removeItem(DEBUG_LOG_KEY);
    } catch {
      /* noop */
    }
    setDebugLog([]);
  }

  // 마운트/언마운트 — id는 마운트마다 다른 값. 카메라 촬영마다 리마운트가 일어나는지 이게 증명한다.
  // 마운트 시 기존 sessionStorage 로그를 먼저 읽어 이어붙인다(리마운트 누적).
  useEffect(() => {
    try {
      const prev = JSON.parse(sessionStorage.getItem(DEBUG_LOG_KEY) ?? "[]") as string[];
      if (prev.length > 0) setDebugLog(prev);
    } catch {
      /* noop */
    }
    const id = Math.random().toString(36).slice(2, 7);
    dlog("[vocab-photo] MOUNT #" + id);
    return () => dlog("[vocab-photo] UNMOUNT #" + id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // files 변화 추적 — 누적이 실제로 쌓이는지(리마운트로 리셋되는지) 이게 보여준다.
  useEffect(() => {
    dlog("[vocab-photo] files -> " + files.length + " [" + files.map((f) => f.name).join(", ") + "]");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  // cropQueue 길이 전이 추적 — enqueue 결과·crop done/cancel 슬라이스가 모두 여기로 잡힌다.
  useEffect(() => {
    dlog("[vocab-photo] cropQueue -> " + cropQueue.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropQueue]);

  const busy = phase === "reading" || phase === "saving";

  // 경과 시간 — 판독은 사진 여러 장 병렬이라 10~20초. 숫자가 올라가면 "멈췄나?"가 크게 준다
  useEffect(() => {
    if (!busy) return;
    setElapsedSec(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsedSec(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // 미리보기 object URL 해제 — 언마운트 시 (previews가 바뀔 때마다는 removeFile/reset이 직접 해제)
  useEffect(() => {
    return () => {
      previews.forEach((url) => URL.revokeObjectURL(url));
    };
    // 의도적으로 마운트/언마운트에만 — previews를 deps에 넣으면 매 변경마다 살아 있는 URL을 해제한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearStatus() {
    setErrorKo(null);
    setIssues([]);
    setCanRetry(false);
    setRetakeKo(null);
  }

  // -------------------------------------------------------------------------
  // 1) 사진 누적 (판독 전)
  // -------------------------------------------------------------------------

  /**
   * 새로 고른 사진을 **자르기 큐**에 넣는다 — 목록에 바로 넣지 않는다. 맨 앞부터 자동으로
   * 자르기 모달이 열리고(아래 큐 cropper), onDone이 결과를 `appendCroppedFile`로 목록에
   * 넣는다. 상한을 넘길 만큼은 애초에 큐에 담지 않는다(이미 담긴 것 + 큐 대기분 제외).
   */
  function enqueueForCrop(list: FileList | null) {
    const added = Array.from(list ?? []);
    dlog(
      "[vocab-photo] enqueueForCrop added=" +
        added.length +
        " files=" +
        files.length +
        " queue=" +
        cropQueue.length +
        " remaining=" +
        Math.max(0, VOCAB_LIMITS.photos - files.length - cropQueue.length),
    );
    if (added.length === 0) return;
    clearStatus();
    const remaining = Math.max(0, VOCAB_LIMITS.photos - files.length - cropQueue.length);
    if (remaining === 0) return;
    setCropQueue((q) => [...q, ...added.slice(0, remaining)]);
  }

  /** 자른(또는 "전체 사용" 원본) 한 장을 목록 끝에 추가 — 파일·미리보기 URL을 짝지어 넣는다. */
  function appendCroppedFile(next: File) {
    dlog("[vocab-photo] appendCroppedFile name=" + next.name + " size=" + next.size);
    clearStatus();
    const url = URL.createObjectURL(next); // 순수 updater 유지 위해 밖에서 생성
    setFiles((prev) => [...prev, next]);
    setPreviews((prev) => [...prev, url]);
  }

  function removeFile(index: number) {
    clearStatus();
    setPreviews((prev) => {
      const url = prev[index];
      if (url) URL.revokeObjectURL(url);
      return prev.filter((_, i) => i !== index);
    });
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  /** 한 장을 자른 결과로 교체 — 파일과 미리보기 URL을 짝지어 바꾸고 옛 URL을 해제한다. */
  function replaceFile(index: number, next: File) {
    clearStatus();
    setPreviews((prev) => {
      const url = prev[index];
      if (url) URL.revokeObjectURL(url);
      return prev.map((u, i) => (i === index ? URL.createObjectURL(next) : u));
    });
    setFiles((prev) => prev.map((f, i) => (i === index ? next : f)));
  }

  function resetToPick() {
    previews.forEach((url) => URL.revokeObjectURL(url));
    setPreviews([]);
    setFiles([]);
    setCropQueue([]); // 대기 중 자르기도 함께 비운다(잔여 방지)
    setEntries([]);
    setExcluded(new Set());
    setEditing(new Set());
    setMeta(null);
    setTitleKo("");
    clearStatus();
    setPhase("pick");
  }

  // -------------------------------------------------------------------------
  // 2) 판독 (호출 C — 여러 장을 한 번에 보내면 라우트가 병렬 호출 + 병합)
  // -------------------------------------------------------------------------

  async function readAll() {
    if (runningRef.current) return;
    if (files.length === 0) return;
    runningRef.current = true;
    clearStatus();
    setPhase("reading");

    try {
      dlog(
        "[vocab-photo] readAll sending files=" +
          files.length +
          " [" +
          files.map((f) => f.name).join(", ") +
          "]",
      );
      const images = await Promise.all(files.map((f) => resizeToJpegDataUrl(f)));
      dlog("[vocab-photo] readAll resized lens=" + images.map((s) => s.length).join("|"));
      const res = await fetch("/api/english/vocab/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const data = (await res.json().catch(() => null)) as VocabExtractResponse | null;

      if (data?.ok) {
        setEntries(data.entries);
        setExcluded(new Set());
        setEditing(new Set());
        setMeta({
          dayLabel: data.dayLabel,
          mergedCount: data.mergedCount,
          missingNos: data.missingNos,
          photoCount: data.photoCount,
          failedPhotoCount: data.failedPhotoCount,
        });
        setTitleKo(data.dayLabel ?? "");
        setPhase("review");
        return;
      }

      // §7-6 폴백 — 다시 찍기. 오류가 아니라 정상 갈래다. 고른 사진은 지우지 않는다(다시 눌러 볼 수 있게).
      if (data && "reason" in data) {
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
    } finally {
      runningRef.current = false;
    }
  }

  // -------------------------------------------------------------------------
  // 3) 검토 편집
  // -------------------------------------------------------------------------

  function updateEntry(index: number, patch: Partial<VocabEntry>) {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }

  function toggleExclude(index: number) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else {
        next.add(index);
        // 뺀 항목은 편집도 닫는다
        setEditing((ed) => {
          const n = new Set(ed);
          n.delete(index);
          return n;
        });
      }
      return next;
    });
  }

  function toggleEdit(index: number) {
    setEditing((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const keptCount = entries.length - excluded.size;

  // -------------------------------------------------------------------------
  // 4) 저장 (사진 없이 텍스트만 — §7-6)
  // -------------------------------------------------------------------------

  async function save() {
    if (runningRef.current) return;
    if (keptCount === 0) return;
    runningRef.current = true;
    clearStatus();
    setPhase("saving");

    // 뺀 항목 제외 + 편집 잔여 정리(빈 뜻·빈 발음 정돈). 값은 손대지 않는다 — 정돈만.
    const kept: VocabEntry[] = entries
      .filter((_, i) => !excluded.has(i))
      .map((e) => ({
        ...e,
        word: e.word.trim(),
        ipa: e.ipa?.trim() ? e.ipa.trim() : null,
        // 뜻마다 ko를 다듬고 빈 뜻은 뺀다. no·related는 그대로 살려 구조를 보존한다(§6 왕복)
        meanings: e.meanings
          .map((m) => ({ ...m, ko: m.ko.trim() }))
          .filter((m) => m.ko !== ""),
      }));

    try {
      const res = await fetch("/api/english/vocab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          titleKo: titleKo.trim() || null,
          dayLabel: meta?.dayLabel ?? null,
          photoCount: meta?.photoCount ?? files.length,
          entries: kept,
        }),
      });
      const data = (await res.json().catch(() => null)) as VocabCreateResponse | null;

      if (res.ok && data?.ok) {
        // 저장 성공 → 표 화면으로. 뒤로가기로 이 화면에 다시 오지 않게 replace가 아니라 push(다시 만들 수 있게)
        router.push(`/english/vocab/${data.id}`);
        return;
      }

      setErrorKo(
        data && "messageKo" in data
          ? data.messageKo
          : "저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
      setIssues(data && "issues" in data ? (data.issues ?? []).map((i) => i.message) : []);
      setPhase("review");
    } catch {
      setErrorKo("네트워크 문제로 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
      setPhase("review");
    } finally {
      runningRef.current = false;
    }
  }

  // -------------------------------------------------------------------------
  // 렌더
  // -------------------------------------------------------------------------

  // 진단용 디버그 패널 — 모든 phase 하단에 붙여 어느 화면에서도 폰으로 읽고 복사할 수 있게.
  // (개발용이지만 재현 전까지 항상 보이게 둔다. 재현 후 제거 예정.)
  const debugPanel = (
    <div className="mt-6 rounded-[var(--radius-box)] border border-line">
      <button
        type="button"
        onClick={() => setDebugOpen((v) => !v)}
        className="t-meta-chip flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span>🐞 디버그 로그 ({debugLog.length})</span>
        <span aria-hidden>{debugOpen ? "▲" : "▼"}</span>
      </button>
      {debugOpen && (
        <div className="border-t border-line px-3 py-2">
          <div className="mb-2 flex gap-2">
            <button
              type="button"
              onClick={copyDebugLog}
              className="u-btn u-btn-secondary px-3 py-1 text-meta-chip"
            >
              📋 복사
            </button>
            <button
              type="button"
              onClick={clearDebugLog}
              className="u-btn u-btn-secondary px-3 py-1 text-meta-chip"
            >
              🧹 지우기
            </button>
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-tight text-ink-3">
            {debugLog.length > 0 ? debugLog.join("\n") : "아직 로그가 없어요."}
          </pre>
        </div>
      )}
    </div>
  );

  if (phase === "reading" || phase === "saving") {
    return (
      <>
        <div className="u-box text-center" role="status" aria-live="polite">
          <p className="t-section-title">
            {phase === "reading" ? "📖 단어를 읽고 있어요…" : "💾 저장하고 있어요…"}
          </p>
          <p className="t-caption mt-2">
            {phase === "reading"
              ? `사진 ${files.length}장을 한 번에 읽는 중이에요. 잠깐만 기다려 주세요.`
              : "곧 단어 표로 데려다 드릴게요."}
            {elapsedSec >= 3 ? ` (${elapsedSec}초)` : ""}
          </p>
        </div>
        {debugPanel}
      </>
    );
  }

  if (phase === "review") {
    return (
      <>
        <VocabReview
          entries={entries}
          excluded={excluded}
          editing={editing}
          titleKo={titleKo}
          meta={meta}
          keptCount={keptCount}
          errorKo={errorKo}
          issues={issues}
          onTitleChange={setTitleKo}
          onToggleExclude={toggleExclude}
          onToggleEdit={toggleEdit}
          onUpdateEntry={updateEntry}
          onSave={save}
          onBack={resetToPick}
        />
        {debugPanel}
      </>
    );
  }

  // phase === "pick"
  return (
    <div>
      {/* 항상 마운트되는 숨은 파일 입력 — capture 금지(carousel 한 장 문제), 덧붙이기 (home-create 규약) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          dlog(
            "[vocab-photo] input.onChange n=" +
              picked.length +
              " names=" +
              picked.map((f) => f.name).join("|") +
              " sizes=" +
              picked.map((f) => f.size).join("|") +
              " types=" +
              picked.map((f) => f.type).join("|"),
          );
          enqueueForCrop(e.target.files); // 목록에 넣기 전에 자르기 큐로 — 한 장씩 자동 오픈
          e.target.value = ""; // 같은 사진을 다시 골라도 change가 발생하게
        }}
      />

      <div className="u-box">
        <p className="t-section-title">📷 단어장 페이지를 찍어요</p>
        <p className="t-caption mt-2">
          DAY 하나를 여러 장으로 나눠 찍어도 돼요. 겹쳐 찍으면 번호로 알아서 합쳐 드려요. 최대{" "}
          {VOCAB_LIMITS.photos}장.
        </p>

        {previews.length > 0 && (
          <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {previews.map((url, i) => (
              <li key={url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 object URL 미리보기 */}
                <img
                  src={url}
                  alt={`고른 사진 ${i + 1}`}
                  className="aspect-square w-full rounded-[var(--radius-box)] border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  aria-label={`사진 ${i + 1} 빼기`}
                  className="t-meta-chip absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-bg text-ink shadow-sm"
                >
                  ✕
                </button>
                {/* 선택 사항 — 이 장만 잘라 배경·손가락을 빼면 더 잘 읽혀요 */}
                <button
                  type="button"
                  onClick={() => setCropIndex(i)}
                  aria-label={`사진 ${i + 1} 자르기`}
                  className="t-meta-chip absolute bottom-1 left-1 flex items-center gap-1 rounded-full border border-line bg-bg px-2 py-1 text-ink shadow-sm"
                >
                  ✂️ 자르기
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="u-btn u-btn-secondary flex-1"
          >
            <span aria-hidden>➕</span>{" "}
            {previews.length === 0 ? "사진 고르기" : `사진 더 넣기 (${previews.length}/${VOCAB_LIMITS.photos})`}
          </button>
          {previews.length > 0 && (
            <button
              type="button"
              onClick={readAll}
              disabled={runningRef.current}
              className="u-btn u-btn-primary flex-1"
            >
              <span aria-hidden>📖</span> {previews.length}장 판독하기
            </button>
          )}
        </div>
      </div>

      {/* §7-6 다시 찍기 안내 — 오류 배너와 문구·행동이 다르다 */}
      {retakeKo && (
        <p role="status" className="u-box-accent t-question-ko mt-4 text-ink">
          📷 {retakeKo}
        </p>
      )}

      {errorKo && (
        <div
          role="alert"
          className="mt-4 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3"
        >
          <p className="t-question-ko text-danger">{errorKo}</p>
          {issues.length > 0 && (
            <ul className="t-caption mt-2 list-disc pl-5">
              {issues.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          )}
          {canRetry && (
            <button type="button" onClick={readAll} className="u-btn u-btn-secondary mt-3">
              <span aria-hidden>🔄</span> 다시 읽기
            </button>
          )}
        </div>
      )}

      {/*
       * 자르기 모달 — 두 진입.
       * (1) **큐**: 새로 고른 사진. 목록에 넣기 전에 한 장씩 자동으로 연다.
       *     onDone → 결과를 목록에 추가 + 큐 한 칸 당김. 취소 → 그 장만 버리고 큐 당김.
       * (2) **다시 자르기**: 이미 담긴 사진의 썸네일 "✂️ 자르기". replaceFile로 교체.
       * 큐가 우선한다(새 사진을 다 처리한 뒤에야 다시 자르기 모달이 뜬다).
       */}
      {cropQueue[0] ? (
        <ImageCropper
          file={cropQueue[0]}
          onDone={(result) => {
            dlog(
              "[vocab-photo] crop done queue " +
                cropQueue.length +
                "->" +
                (cropQueue.length - 1) +
                " result=" +
                result.name +
                " size=" +
                result.size,
            );
            appendCroppedFile(result);
            setCropQueue((q) => q.slice(1));
          }}
          onCancel={() => {
            dlog("[vocab-photo] crop cancel queue " + cropQueue.length + "->" + (cropQueue.length - 1));
            setCropQueue((q) => q.slice(1));
          }}
        />
      ) : cropIndex != null && files[cropIndex] ? (
        <ImageCropper
          file={files[cropIndex]}
          onDone={(result) => {
            replaceFile(cropIndex, result); // 자른 결과(또는 "전체 사용" 원본)로 그 장을 교체
            setCropIndex(null);
          }}
          onCancel={() => setCropIndex(null)}
        />
      ) : null}

      {debugPanel}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 검토 화면 (별 컴포넌트로 떼어 본체 상태 로직과 렌더를 가른다)
// ---------------------------------------------------------------------------

function VocabReview({
  entries,
  excluded,
  editing,
  titleKo,
  meta,
  keptCount,
  errorKo,
  issues,
  onTitleChange,
  onToggleExclude,
  onToggleEdit,
  onUpdateEntry,
  onSave,
  onBack,
}: {
  entries: VocabEntry[];
  excluded: Set<number>;
  editing: Set<number>;
  titleKo: string;
  meta: ReviewMeta | null;
  keptCount: number;
  errorKo: string | null;
  issues: string[];
  onTitleChange: (v: string) => void;
  onToggleExclude: (i: number) => void;
  onToggleEdit: (i: number) => void;
  onUpdateEntry: (i: number, patch: Partial<VocabEntry>) => void;
  onSave: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      {/* 판독 요약 안내 */}
      <div className="u-box">
        <div className="flex items-baseline justify-between gap-3">
          <p className="t-section-title">읽은 단어 {entries.length}개</p>
          <p className="t-caption flex-none">저장 {keptCount}개</p>
        </div>

        {meta && meta.mergedCount > 0 && (
          <p className="t-caption mt-2">✅ 겹쳐 찍은 단어 {meta.mergedCount}개를 하나로 합쳤어요.</p>
        )}
        {meta && meta.failedPhotoCount > 0 && (
          <p className="t-caption mt-1">
            ⚠️ 사진 {meta.photoCount}장 중 {meta.failedPhotoCount}장을 읽지 못했어요. 빠진 단어가 있으면
            그 페이지를 다시 찍어 주세요.
          </p>
        )}
        {meta && meta.missingNos.length > 0 && (
          <p className="t-caption mt-1">
            🔎 {meta.missingNos.slice(0, 10).join(", ")}
            {meta.missingNos.length > 10 ? " 등" : ""}번이 빠진 것 같아요 — 그 번호가 있는 사진이
            빠졌을 수 있어요.
          </p>
        )}

        {/* 이름 — 표 제목·목록에 뜬다. dayLabel로 미리 채워 두고 엄빠가 고칠 수 있게 */}
        <label className="mt-4 block">
          <span className="t-meta-chip">이름</span>
          <input
            type="text"
            value={titleKo}
            onChange={(e) => onTitleChange(e.target.value)}
            maxLength={VOCAB_LIMITS.titleKo}
            placeholder="예: DAY 01"
            className="mt-1 w-full rounded-[var(--radius-box)] border border-line bg-bg px-3 py-2 text-ink"
          />
        </label>
      </div>

      <p className="t-caption mt-4">
        틀리게 읽은 단어는 <span className="font-medium text-ink">고치기</span>로 손보고, 저장하고
        싶지 않은 단어는 <span className="font-medium text-ink">빼기</span>를 눌러 주세요.
      </p>

      {/* 단어 목록 — 세로 카드 */}
      <ul className="mt-3 flex flex-col gap-2">
        {entries.map((entry, i) => {
          const isExcluded = excluded.has(i);
          const isEditing = editing.has(i);
          return (
            <li
              key={i}
              className={`rounded-[var(--radius-box)] border p-4 ${
                isExcluded ? "border-dashed border-line opacity-55" : "border-line"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    {entry.no && <span className="t-meta-chip flex-none">{entry.no}</span>}
                    <span className="t-vocab-word">{entry.word}</span>
                    {entry.ipa && <span className="t-vocab-pron">[{entry.ipa}]</span>}
                  </div>
                  {entry.pos.length > 0 && (
                    <p className="t-caption mt-0.5">
                      {entry.pos.map((p) => PART_OF_SPEECH_LABELS_KO[p]).join(" · ")}
                    </p>
                  )}
                </div>
                <div className="flex flex-none flex-col gap-1">
                  {!isExcluded && (
                    <button
                      type="button"
                      onClick={() => onToggleEdit(i)}
                      aria-pressed={isEditing}
                      className={`u-btn ${isEditing ? "u-btn-primary" : "u-btn-secondary"} px-3 py-1.5 text-meta-chip`}
                    >
                      {isEditing ? "접기" : "✏️ 고치기"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onToggleExclude(i)}
                    aria-pressed={isExcluded}
                    className={`u-btn px-3 py-1.5 text-meta-chip ${
                      isExcluded ? "u-btn-primary" : "u-btn-secondary"
                    }`}
                  >
                    {isExcluded ? "↩️ 되살리기" : "🗑 빼기"}
                  </button>
                </div>
              </div>

              {/* 판독 표시 — 잘림·흐림 (§7-6) */}
              {(entry.partial || entry.confidence === "low") && !isExcluded && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {entry.partial && (
                    <span className="u-chip border-danger text-danger">✂️ 사진 밖으로 잘렸어요</span>
                  )}
                  {entry.confidence === "low" && (
                    <span className="u-chip border-danger text-danger">🌫 흐릿하게 읽혔어요</span>
                  )}
                </div>
              )}

              {/* 뜻 — 번호와 함께, 뜻마다 줄바꿈(세미콜론으로 뭉개지 않는다). 뜻 옆 유의어는 그 뜻 아래 칩으로 */}
              {!isEditing && entry.meanings.length > 0 && (
                <ol className="mt-2 flex flex-col gap-1">
                  {entry.meanings.map((m, k) => (
                    <li key={k} className="t-vocab-meaning">
                      {m.no !== null && <span className="mr-1 tabular-nums text-ink-3">{m.no}.</span>}
                      {m.ko}
                      {m.related.length > 0 && (
                        <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                          {m.related.map((r, j) => (
                            <span key={j} className="u-chip">
                              {RELATED_KIND_LABELS_KO[r.kind]} {r.word}
                            </span>
                          ))}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              {/* 예문·관련어 — 읽기 전용(책 전사본, V1은 편집 밖). 뺀 항목엔 접는다 */}
              {!isEditing && !isExcluded && entry.examples.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {entry.examples.map((ex, k) => (
                    <li key={k} className="t-vocab-example">
                      {ex.en}
                      {ex.ko ? <span className="block text-ink-3">{ex.ko}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {!isEditing && !isExcluded && entry.related.length > 0 && (
                <p className="t-caption mt-2">
                  {entry.related
                    .map((r) => `${RELATED_KIND_LABELS_KO[r.kind]} ${r.word}`)
                    .join(" · ")}
                </p>
              )}

              {/* 인라인 편집 — 자주 틀리는 세 가지(단어·발음·뜻)만 연다 (예문은 전사 보존, V1 편집 밖) */}
              {isEditing && !isExcluded && (
                <div className="mt-3 flex flex-col gap-3">
                  <label className="block">
                    <span className="t-meta-chip">단어</span>
                    <input
                      type="text"
                      value={entry.word}
                      onChange={(e) => onUpdateEntry(i, { word: e.target.value })}
                      maxLength={VOCAB_LIMITS.word}
                      className="mt-1 w-full rounded-[var(--radius-box)] border border-line bg-bg px-3 py-2 text-ink"
                    />
                    <CharCount value={entry.word} max={VOCAB_LIMITS.word} />
                  </label>
                  <label className="block">
                    <span className="t-meta-chip">발음기호 (대괄호 없이)</span>
                    <input
                      type="text"
                      value={entry.ipa ?? ""}
                      onChange={(e) => onUpdateEntry(i, { ipa: e.target.value || null })}
                      maxLength={VOCAB_LIMITS.ipa}
                      placeholder="예: pʌk"
                      className="mt-1 w-full rounded-[var(--radius-box)] border border-line bg-bg px-3 py-2 text-ink"
                    />
                  </label>
                  {/*
                   * 뜻 편집 — 뜻마다 한 줄씩 연다(번호·유의어는 그대로 보존). 옛 한 줄 textarea는
                   * 뜻의 번호·유의어를 왕복 못 시켜 "3가지 의미 의도"가 사라졌다 → 뜻별 입력으로 바꿈.
                   */}
                  <div className="block">
                    <span className="t-meta-chip">뜻 (뜻마다 한 줄)</span>
                    {entry.meanings.length > 0 ? (
                      <div className="mt-1 flex flex-col gap-2">
                        {entry.meanings.map((m, k) => (
                          <div key={k}>
                            <div className="flex items-center gap-2">
                              {m.no !== null && (
                                <span className="t-meta-chip flex-none tabular-nums">{m.no}</span>
                              )}
                              <input
                                type="text"
                                value={m.ko}
                                onChange={(e) =>
                                  onUpdateEntry(i, {
                                    meanings: entry.meanings.map((mm, mi) =>
                                      mi === k ? { ...mm, ko: e.target.value } : mm,
                                    ),
                                  })
                                }
                                maxLength={VOCAB_LIMITS.meaningKo}
                                className="w-full rounded-[var(--radius-box)] border border-line bg-bg px-3 py-2 text-ink"
                              />
                            </div>
                            {m.related.length > 0 && (
                              <span className="mt-1 flex flex-wrap gap-1">
                                {m.related.map((r, j) => (
                                  <span key={j} className="u-chip">
                                    {RELATED_KIND_LABELS_KO[r.kind]} {r.word}
                                  </span>
                                ))}
                              </span>
                            )}
                            <CharCount value={m.ko} max={VOCAB_LIMITS.meaningKo} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="t-caption mt-1">읽어온 뜻이 없어요.</p>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {errorKo && (
        <div
          role="alert"
          className="mt-4 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3"
        >
          <p className="t-question-ko text-danger">{errorKo}</p>
          {issues.length > 0 && (
            <ul className="t-caption mt-2 list-disc pl-5">
              {issues.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 저장 / 처음부터 */}
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={keptCount === 0}
          className="u-btn u-btn-primary flex-1"
        >
          <span aria-hidden>💾</span> {keptCount}개 단어 저장하기
        </button>
        <button type="button" onClick={onBack} className="u-btn u-btn-secondary flex-none">
          <span aria-hidden>↩️</span> 처음부터
        </button>
      </div>
      {keptCount === 0 && (
        <p className="t-caption mt-2 text-center">
          모든 단어를 뺐어요. 하나 이상 <span className="font-medium text-ink">되살리기</span>해야
          저장할 수 있어요.
        </p>
      )}

      <p className="t-caption mt-6 text-center">
        <Link href="/english/vocab" className="text-accent underline">
          단어장 목록으로
        </Link>
      </p>
    </div>
  );
}

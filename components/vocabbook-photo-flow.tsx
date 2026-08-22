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
  /** 자르기 모달에 올릴 사진의 인덱스. null이면 모달을 닫는다. (한 장씩 자른다) */
  const [cropIndex, setCropIndex] = useState<number | null>(null);

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

  function onPickFiles(list: FileList | null) {
    const added = Array.from(list ?? []);
    if (added.length === 0) return;
    clearStatus();
    setFiles((prev) => {
      const merged = [...prev, ...added].slice(0, VOCAB_LIMITS.photos);
      // 미리보기도 같은 슬라이스로 맞춘다 (덧붙이기 — 카메라는 한 번에 한 장만 돌려준다)
      setPreviews((prevUrls) => {
        const addedUrls = added.map((f) => URL.createObjectURL(f));
        const nextUrls = [...prevUrls, ...addedUrls];
        // 상한을 넘겨 잘린 뒤쪽 URL은 해제한다
        nextUrls.slice(VOCAB_LIMITS.photos).forEach((u) => URL.revokeObjectURL(u));
        return nextUrls.slice(0, VOCAB_LIMITS.photos);
      });
      return merged;
    });
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
      const images = await Promise.all(files.map((f) => resizeToJpegDataUrl(f)));
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
        meaningsKo: e.meaningsKo.map((m) => m.trim()).filter((m) => m !== ""),
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

  if (phase === "reading" || phase === "saving") {
    return (
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
    );
  }

  if (phase === "review") {
    return (
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
          onPickFiles(e.target.files);
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

      {cropIndex != null && files[cropIndex] && (
        <ImageCropper
          file={files[cropIndex]}
          onDone={(result) => {
            replaceFile(cropIndex, result); // 자른 결과(또는 "전체 사용" 원본)로 그 장을 교체
            setCropIndex(null);
          }}
          onCancel={() => setCropIndex(null)}
        />
      )}
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

              {/* 뜻 */}
              {!isEditing && entry.meaningsKo.length > 0 && (
                <p className="t-vocab-meaning mt-2">{entry.meaningsKo.join("; ")}</p>
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
                  <label className="block">
                    <span className="t-meta-chip">뜻 (한 줄에 하나씩)</span>
                    <textarea
                      value={entry.meaningsKo.join("\n")}
                      onChange={(e) => onUpdateEntry(i, { meaningsKo: e.target.value.split("\n") })}
                      rows={Math.max(2, entry.meaningsKo.length)}
                      className="mt-1 w-full rounded-[var(--radius-box)] border border-line bg-bg px-3 py-2 text-ink"
                    />
                    {entry.meaningsKo.map((m, k) => (
                      <CharCount key={k} value={m} max={VOCAB_LIMITS.meaningKo} />
                    ))}
                  </label>
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

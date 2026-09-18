"use client";

/**
 * 일본어 JLPT 단어장 목록 화면 (아빠의 일본어 J1) — 클라이언트 컴포넌트.
 *
 * 서버(`app/japanese/vocab/page.tsx`)가 읽어 줄인 목록을 받아 **고르고 지우고 순서만** 바꾼다.
 * 삭제·순서변경은 관리 모드에서만(아이용은 아니지만 실수 삭제 방지). 영어 `vocab-library-view`의 관용구를
 * 그대로 따르되(useReorder 공유 프리미티브), 라우트만 일본어(`/api/japanese/vocab/*`)로 바꾼다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useReorder } from "@/components/use-reorder";
import type { JlptLevel } from "@/lib/japanese-vocab-contract";

/** 서버가 목록 줄에 필요한 것만 줄여 넘긴다(entries 전문 X — 무겁다). */
export interface JaVocabLibraryItem {
  id: string;
  titleKo: string;
  kind: "jlpt" | "collected";
  levels: JlptLevel[];
  topic: string | null;
  wordCount: number;
  createdAt: string; // ISO 8601
  sortIndex: number | null;
}

/** 만든 날짜 — 타임존 계산 없이 ISO 날짜부만(SSR/클라 동일 출력) */
function formatDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, ".");
}

export default function JaVocabLibraryView({
  items,
  skippedCount = 0,
}: {
  items: JaVocabLibraryItem[];
  skippedCount?: number;
}) {
  const router = useRouter();
  const [manageMode, setManageMode] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [noticeKo, setNoticeKo] = useState<string | null>(null);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  const visibleItems = items.filter((item) => !deletedIds.includes(item.id));

  const reorder = useReorder({
    ids: visibleItems.map((item) => item.id),
    enabled: manageMode,
    onPersist: async (orderedIds) => {
      const res = await fetch("/api/japanese/vocab/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      });
      if (!res.ok) throw new Error("reorder failed");
      setErrorKo(null);
      router.refresh();
    },
    onError: () => setErrorKo("순서를 저장하지 못했어요. 잠시 후 다시 시도해 주세요."),
  });

  const itemById = new Map(visibleItems.map((item) => [item.id, item]));
  const orderedItems = reorder.order
    .map((id) => itemById.get(id))
    .filter((item): item is JaVocabLibraryItem => item != null);

  function toggleManage() {
    setManageMode((on) => !on);
    setConfirmId(null);
    setErrorKo(null);
    setNoticeKo(null);
  }

  async function runDelete(item: JaVocabLibraryItem) {
    setDeletingId(item.id);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/japanese/vocab/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; messageKo?: string } | null;
      if (res.ok && data?.ok) {
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        setNoticeKo("단어장 하나를 지웠어요.");
        router.refresh();
        return;
      }
      if (res.status === 404) {
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        setNoticeKo("이미 지워져 있었어요.");
        router.refresh();
        return;
      }
      setErrorKo(data?.messageKo ?? "지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 지우지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      {skippedCount > 0 && (
        <p role="status" className="u-box t-caption mb-4 border border-line-strong">
          ⚠️ 예전 형식이라 열지 못한 단어장이 {skippedCount}개 있어요. 아래 목록에는 빠져 있어요.
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Link href="/japanese/vocab/new" className="u-btn u-btn-primary flex-1">
          <span aria-hidden>✨</span> 새 단어장 만들기
        </Link>
      </div>

      <section aria-label="단어장 목록" className="mt-8">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="t-section-title">내 단어장</h2>
          {visibleItems.length > 0 && (
            <button
              type="button"
              onClick={toggleManage}
              aria-pressed={manageMode}
              className={`u-btn flex-none px-3 py-1.5 text-meta-chip ${manageMode ? "u-btn-primary" : "u-btn-secondary"}`}
            >
              {manageMode ? "완료" : "관리"}
            </button>
          )}
        </div>

        {manageMode && (
          <p className="t-caption mb-3 rounded-[var(--radius-box)] border border-dashed border-line px-4 py-3">
            <span className="font-medium text-ink">≡ 손잡이를 끌어</span> 순서를 바꾸거나{" "}
            <span className="font-medium text-ink">↑ ↓ 버튼</span>으로 옮겨요. 지울 단어장은{" "}
            <span className="font-medium text-ink">🗑 지우기</span> —{" "}
            <span className="font-medium text-ink">되돌릴 수 없어요.</span>
          </p>
        )}

        {noticeKo && (
          <p role="status" className="u-box-accent t-question-ko mb-3 text-ink">
            ✅ {noticeKo}
          </p>
        )}
        {errorKo && (
          <p
            role="alert"
            className="t-question-ko mb-3 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3 text-danger"
          >
            {errorKo}
          </p>
        )}

        {visibleItems.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            아직 만든 단어장이 없어요. 위 버튼으로 첫 단어장을 만들어 볼까요?
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {orderedItems.map((item) =>
              confirmId === item.id ? (
                <li key={item.id}>
                  <div role="group" aria-label="삭제 확인" className="rounded-[var(--radius-box)] border border-danger bg-danger-soft p-4">
                    <p className="t-list-title">{item.titleKo}</p>
                    <p className="t-caption mt-1">
                      이 단어장을 지울까요? <span className="font-medium text-danger">되돌릴 수 없어요.</span>
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void runDelete(item)}
                        disabled={deletingId === item.id}
                        className="u-btn flex-1 bg-danger text-bg"
                      >
                        {deletingId === item.id ? "지우는 중…" : "지우기"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        disabled={deletingId === item.id}
                        className="u-btn u-btn-secondary flex-1"
                      >
                        취소
                      </button>
                    </div>
                  </div>
                </li>
              ) : (
                <li
                  key={item.id}
                  {...reorder.getRowProps(item.id)}
                  className={`flex min-w-0 items-stretch gap-2 rounded-[var(--radius-box)] ${
                    reorder.draggingId === item.id ? "opacity-90 ring-2 ring-accent" : ""
                  }`}
                >
                  {manageMode && (
                    <div
                      {...reorder.getHandleProps(item.id)}
                      className="t-list-title flex w-8 flex-none select-none items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink-3 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent print:hidden"
                    >
                      <span aria-hidden>≡</span>
                    </div>
                  )}
                  <Link href={`/japanese/vocab/${item.id}`} className="u-item min-w-0 flex-1">
                    <span className="u-item-thumb" aria-hidden>
                      🗂️
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="t-list-title block truncate">{item.titleKo}</span>
                      <span className="t-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="u-chip">단어 {item.wordCount}개</span>
                        {item.levels.map((lv) => (
                          <span key={lv} className="u-chip">
                            {lv}
                          </span>
                        ))}
                        {item.topic && <span className="u-chip">{item.topic}</span>}
                        <span className="t-caption">{formatDate(item.createdAt)}</span>
                      </span>
                    </span>
                  </Link>

                  {manageMode && (
                    <div className="flex w-9 flex-none flex-col gap-1 print:hidden">
                      <button
                        type="button"
                        onClick={() => reorder.moveUp(item.id)}
                        disabled={!reorder.canMoveUp(item.id) || reorder.saving}
                        aria-label={`${item.titleKo} 위로`}
                        className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30 hover:enabled:border-line-strong"
                      >
                        <span aria-hidden>↑</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => reorder.moveDown(item.id)}
                        disabled={!reorder.canMoveDown(item.id) || reorder.saving}
                        aria-label={`${item.titleKo} 아래로`}
                        className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30 hover:enabled:border-line-strong"
                      >
                        <span aria-hidden>↓</span>
                      </button>
                    </div>
                  )}

                  {manageMode && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmId(item.id);
                        setErrorKo(null);
                        setNoticeKo(null);
                      }}
                      aria-label="이 단어장 지우기"
                      className="t-meta-chip flex w-14 flex-none flex-col items-center justify-center gap-0.5 rounded-[var(--radius-box)] border border-danger bg-bg text-danger transition hover:bg-danger-soft print:hidden"
                    >
                      <span aria-hidden>🗑</span>
                      지우기
                    </button>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </>
  );
}

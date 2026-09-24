"use client";

/**
 * 대화 복습 목록 (아빠의 일본어 J3) — 클라이언트. 관리모드 삭제·순서변경(useReorder 공유). 라우트만 dialog로.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useReorder } from "@/components/use-reorder";
import { formatKstDate } from "@/lib/kst";

export interface JaDialogLibraryItem {
  id: string;
  titleKo: string;
  createdAt: string;
  turnCount: number;
  hasCoaching: boolean;
  partial: boolean;
  sortIndex: number | null;
}

export default function JaDialogLibraryView({ items }: { items: JaDialogLibraryItem[] }) {
  const router = useRouter();
  const [manageMode, setManageMode] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [errorKo, setErrorKo] = useState<string | null>(null);

  const visible = items.filter((it) => !deletedIds.includes(it.id));
  const reorder = useReorder({
    ids: visible.map((it) => it.id),
    enabled: manageMode,
    onPersist: async (orderedIds) => {
      const res = await fetch("/api/japanese/dialog/reorder", {
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
  const byId = new Map(visible.map((it) => [it.id, it]));
  const ordered = reorder.order.map((id) => byId.get(id)).filter((it): it is JaDialogLibraryItem => it != null);

  async function runDelete(item: JaDialogLibraryItem) {
    setDeletingId(item.id);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/japanese/dialog/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; messageKo?: string } | null;
      if ((res.ok && data?.ok) || res.status === 404) {
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        router.refresh();
        return;
      }
      setErrorKo(data?.messageKo ?? "지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 지우지 못했어요.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Link href="/japanese/dialog/new" className="u-btn u-btn-primary flex-1">
          <span aria-hidden>📷</span> 새 대화 복습 만들기
        </Link>
      </div>

      <section aria-label="대화 목록" className="mt-8">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="t-section-title">내 대화</h2>
          {visible.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setManageMode((on) => !on);
                setConfirmId(null);
                setErrorKo(null);
              }}
              aria-pressed={manageMode}
              className={`u-btn flex-none px-3 py-1.5 text-meta-chip ${manageMode ? "u-btn-primary" : "u-btn-secondary"}`}
            >
              {manageMode ? "완료" : "관리"}
            </button>
          )}
        </div>

        {errorKo && (
          <p role="alert" className="t-question-ko mb-3 rounded-[var(--radius-box)] border border-danger bg-danger-soft px-4 py-3 text-danger">
            {errorKo}
          </p>
        )}

        {visible.length === 0 ? (
          <p className="t-caption rounded-[var(--radius-box)] border border-dashed border-line px-5 py-6 text-center">
            아직 만든 대화 복습이 없어요. 위 버튼으로 스크린샷을 올려 첫 복습을 만들어 볼까요?
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ordered.map((item) =>
              confirmId === item.id ? (
                <li key={item.id}>
                  <div role="group" aria-label="삭제 확인" className="rounded-[var(--radius-box)] border border-danger bg-danger-soft p-4">
                    <p className="t-list-title">{item.titleKo}</p>
                    <p className="t-caption mt-1">이 대화를 지울까요? <span className="font-medium text-danger">되돌릴 수 없어요.</span></p>
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void runDelete(item)} disabled={deletingId === item.id} className="u-btn flex-1 bg-danger text-bg">
                        {deletingId === item.id ? "지우는 중…" : "지우기"}
                      </button>
                      <button type="button" onClick={() => setConfirmId(null)} disabled={deletingId === item.id} className="u-btn u-btn-secondary flex-1">
                        취소
                      </button>
                    </div>
                  </div>
                </li>
              ) : (
                <li
                  key={item.id}
                  {...reorder.getRowProps(item.id)}
                  className={`flex min-w-0 items-stretch gap-2 rounded-[var(--radius-box)] ${reorder.draggingId === item.id ? "opacity-90 ring-2 ring-accent" : ""}`}
                >
                  {manageMode && (
                    <div
                      {...reorder.getHandleProps(item.id)}
                      className="t-list-title flex w-8 flex-none select-none items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink-3 hover:border-line-strong print:hidden"
                    >
                      <span aria-hidden>≡</span>
                    </div>
                  )}
                  <Link href={`/japanese/dialog/${item.id}`} className="u-item min-w-0 flex-1">
                    <span className="u-item-thumb" aria-hidden>💬</span>
                    <span className="min-w-0 flex-1">
                      <span className="t-list-title block truncate">{item.titleKo}</span>
                      <span className="t-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="u-chip">발화 {item.turnCount}개</span>
                        {item.hasCoaching ? <span className="u-chip">해설 있음</span> : <span className="u-chip">해설 없음</span>}
                        {item.partial && <span className="u-chip">일부</span>}
                        <span className="t-caption">{formatKstDate(item.createdAt)}</span>
                      </span>
                    </span>
                  </Link>
                  {manageMode && (
                    <div className="flex w-9 flex-none flex-col gap-1 print:hidden">
                      <button type="button" onClick={() => reorder.moveUp(item.id)} disabled={!reorder.canMoveUp(item.id) || reorder.saving} aria-label={`${item.titleKo} 위로`} className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30">
                        <span aria-hidden>↑</span>
                      </button>
                      <button type="button" onClick={() => reorder.moveDown(item.id)} disabled={!reorder.canMoveDown(item.id) || reorder.saving} aria-label={`${item.titleKo} 아래로`} className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30">
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
                      }}
                      aria-label="이 대화 지우기"
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

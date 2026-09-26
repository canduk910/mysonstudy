"use client";

/**
 * components/talk-history-list.tsx — 지난 자유대화 목록 (SPEC §21-2 1 "관리 모드: 이름 바꾸기·삭제·순서변경")
 *
 * 대화 복습 목록(ja-dialog-library-view)과 같은 관용구: 관리 모드일 때만 드래그 핸들·↑↓(공유 훅 useReorder)·✏️ 이름·🗑 지우기
 * (인라인 확인 — window.confirm 금지, --danger는 파괴 확인에만). 성공하면 router.refresh로 서버 순서·이름을 다시 읽는다.
 * 404(이미 지워짐)는 목록에서 뺀다. 날짜는 formatKstDate(KST).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useReorder } from "@/components/use-reorder";
import { formatKstDate } from "@/lib/kst";
import {
  TALK_TITLE_MAX_CHARS,
  talkSessionHref,
  type TalkDeleteResponse,
  type TalkHistoryItem,
  type TalkRenameResponse,
} from "@/lib/talk-contract";

function minutes(sec: number): string {
  if (sec < 60) return `${Math.max(1, sec)}초`;
  return `${Math.floor(sec / 60)}분${sec % 60 >= 30 ? " 반" : ""}`;
}

export default function TalkHistoryList({ items }: { items: TalkHistoryItem[] }) {
  const router = useRouter();
  const [manageMode, setManageMode] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [errorKo, setErrorKo] = useState<string | null>(null);

  const visible = items.filter((it) => !deletedIds.includes(it.id));
  const reorder = useReorder({
    ids: visible.map((it) => it.id),
    enabled: manageMode,
    onPersist: async (orderedIds) => {
      const res = await fetch("/api/english/talk/reorder", {
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
  const ordered = reorder.order.map((id) => byId.get(id)).filter((it): it is TalkHistoryItem => it != null);

  async function runDelete(item: TalkHistoryItem) {
    setBusyId(item.id);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/english/talk/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as TalkDeleteResponse | null;
      if ((res.ok && data?.ok) || res.status === 404) {
        setDeletedIds((prev) => [...prev, item.id]);
        setConfirmId(null);
        router.refresh();
        return;
      }
      setErrorKo(data && !data.ok ? data.messageKo : "지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      setErrorKo("네트워크 문제로 지우지 못했어요.");
    } finally {
      setBusyId(null);
    }
  }

  async function runRename(item: TalkHistoryItem) {
    const next = draft.trim();
    if (next === "") {
      setErrorKo("이름을 입력해 주세요.");
      return;
    }
    setBusyId(item.id);
    setErrorKo(null);
    try {
      const res = await fetch(`/api/english/talk/${encodeURIComponent(item.id)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ titleKo: next }),
      });
      const data = (await res.json().catch(() => null)) as TalkRenameResponse | null;
      if (data?.ok) {
        setRenamed((prev) => ({ ...prev, [item.id]: data.titleKo }));
        setEditId(null);
        router.refresh();
        return;
      }
      setErrorKo(data && !data.ok ? data.messageKo : "이름을 저장하지 못했어요.");
    } catch {
      setErrorKo("네트워크 문제로 이름을 저장하지 못했어요.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-label="지난 대화" className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="t-section-title">지난 대화</h2>
        {visible.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setManageMode((on) => !on);
              setConfirmId(null);
              setEditId(null);
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
          아직 나눈 대화가 없어요. 위에서 주제를 골라 Sunny 선생님에게 전화해 볼까요?
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {ordered.map((item) => {
            const title = renamed[item.id] ?? item.titleKo;
            if (confirmId === item.id) {
              return (
                <li key={item.id}>
                  <div role="group" aria-label="삭제 확인" className="rounded-[var(--radius-box)] border border-danger bg-danger-soft p-4">
                    <p className="t-list-title">{title}</p>
                    <p className="t-caption mt-1">
                      이 대화를 지울까요? 설명·그림도 함께 지워져요. <span className="font-medium text-danger">되돌릴 수 없어요.</span>
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void runDelete(item)} disabled={busyId === item.id} className="u-btn flex-1 bg-danger text-bg">
                        {busyId === item.id ? "지우는 중…" : "지우기"}
                      </button>
                      <button type="button" onClick={() => setConfirmId(null)} disabled={busyId === item.id} className="u-btn u-btn-secondary flex-1">
                        취소
                      </button>
                    </div>
                  </div>
                </li>
              );
            }
            if (editId === item.id) {
              return (
                <li key={item.id}>
                  <div className="rounded-[var(--radius-box)] border border-line bg-surface p-3">
                    <label className="u-label" htmlFor={`talk-title-${item.id}`}>
                      대화 이름
                    </label>
                    <input
                      id={`talk-title-${item.id}`}
                      className="u-input"
                      value={draft}
                      maxLength={TALK_TITLE_MAX_CHARS}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void runRename(item);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditId(null);
                        }
                      }}
                      disabled={busyId === item.id}
                      autoFocus
                    />
                    <div className="mt-2 flex gap-2">
                      <button type="button" className="u-btn u-btn-primary flex-1" onClick={() => void runRename(item)} disabled={busyId === item.id || draft.trim() === ""}>
                        {busyId === item.id ? "저장 중…" : "저장"}
                      </button>
                      <button type="button" className="u-btn u-btn-secondary flex-1" onClick={() => setEditId(null)} disabled={busyId === item.id}>
                        취소
                      </button>
                    </div>
                  </div>
                </li>
              );
            }
            return (
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
                <Link href={talkSessionHref(item.id)} className="u-item min-w-0 flex-1">
                  <span className="u-item-thumb" aria-hidden>
                    {item.topicKind === "vocab" ? "📓" : "💬"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="t-list-title block truncate">{title}</span>
                    <span className="t-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span className="u-chip">은우 {item.childTurnCount}번 말함</span>
                      <span className="u-chip">{minutes(item.durationSec)}</span>
                      {item.hasScene && <span className="u-chip">그림</span>}
                      {item.explanationCount > 0 && <span className="u-chip">설명 {item.explanationCount}</span>}
                      <span className="t-caption">{formatKstDate(item.createdAt)}</span>
                    </span>
                  </span>
                </Link>
                {manageMode && (
                  <div className="flex w-9 flex-none flex-col gap-1 print:hidden">
                    <button type="button" onClick={() => reorder.moveUp(item.id)} disabled={!reorder.canMoveUp(item.id) || reorder.saving} aria-label={`${title} 위로`} className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30">
                      <span aria-hidden>↑</span>
                    </button>
                    <button type="button" onClick={() => reorder.moveDown(item.id)} disabled={!reorder.canMoveDown(item.id) || reorder.saving} aria-label={`${title} 아래로`} className="t-list-title flex flex-1 items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink disabled:opacity-30">
                      <span aria-hidden>↓</span>
                    </button>
                  </div>
                )}
                {manageMode && (
                  <div className="flex w-12 flex-none flex-col gap-1 print:hidden">
                    <button
                      type="button"
                      onClick={() => {
                        setEditId(item.id);
                        setDraft(title);
                        setConfirmId(null);
                        setErrorKo(null);
                      }}
                      aria-label={`${title} 이름 바꾸기`}
                      className="t-meta-chip flex flex-1 flex-col items-center justify-center rounded-[var(--radius-box)] border border-line bg-bg text-ink-2"
                    >
                      <span aria-hidden>✏️</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmId(item.id);
                        setEditId(null);
                        setErrorKo(null);
                      }}
                      aria-label={`${title} 지우기`}
                      className="t-meta-chip flex flex-1 flex-col items-center justify-center rounded-[var(--radius-box)] border border-danger bg-bg text-danger hover:bg-danger-soft"
                    >
                      <span aria-hidden>🗑</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
